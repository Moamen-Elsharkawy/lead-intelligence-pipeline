/**
 * Lead Intelligence Pipeline - intake runtime.
 *
 * Everything that turns a source-specific payload into the canonical lead, and
 * decides whether that lead is usable. It lives here, not in the workflow, for
 * one reason: this is the code most likely to be wrong, so it is the code that
 * has to be unit-testable outside n8n (`node scripts/test-intake.js`).
 *
 * The three source normalisers in LP-01 therefore do only the part that is
 * genuinely different per source - which field is called what - and hand the
 * result to `finalizeLead`, so phone parsing, email folding, key derivation and
 * validation happen exactly once in the whole system.
 */
const C = require('./constants.js');

const INTAKE = {
  // A bulk import is accepted synchronously, so it has to fit inside a webhook
  // response window. 200 rows is comfortable; above it the endpoint refuses the
  // batch with a message naming the limit, rather than timing out halfway and
  // leaving the caller unable to tell what landed.
  MAX_CSV_ROWS: 200,
  MAX_FREE_TEXT: 4000,
  MAX_RAW_JSON: 4000,
  MIN_PHONE_DIGITS: 8,
  MAX_PHONE_DIGITS: 15,
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** Trim, collapse runs of whitespace, drop control characters, cap length. */
function clean(v, max) {
  return String(v ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'granted', 'agree', 'agreed', 'opted_in', 'opt-in', 'on', 'checked'].includes(s);
}

function falsy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['false', 'no', 'n', '0', 'denied', 'declined', 'refused', 'unsubscribed', 'off'].includes(s);
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------
// The reverse of DIAL_PREFIXES. Built once from the same table, so the two can
// never disagree - a hand-written second map is a bug waiting for the first
// time someone adds a market to one of them.

const ISO_TO_CC = (() => {
  const m = {};
  for (const [cc, iso] of C.DIAL_PREFIXES) if (!m[iso]) m[iso] = cc;
  return m;
})();

// Only the markets this business actually sees. An unrecognised country name
// resolves to '' and the country is then derived from the phone number, which
// is more reliable than a guessed string match.
const COUNTRY_NAMES = {
  egypt: 'EG', 'misr': 'EG', 'مصر': 'EG',
  uae: 'AE', 'united arab emirates': 'AE', dubai: 'AE', 'abu dhabi': 'AE', 'الإمارات': 'AE',
  'saudi arabia': 'SA', saudi: 'SA', ksa: 'SA', riyadh: 'SA', 'السعودية': 'SA',
  qatar: 'QA', kuwait: 'KW', bahrain: 'BH', oman: 'OM', jordan: 'JO', lebanon: 'LB',
  morocco: 'MA', tunisia: 'TN', algeria: 'DZ', iraq: 'IQ', sudan: 'SD', libya: 'LY',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', britain: 'GB',
  usa: 'US', 'united states': 'US', us: 'US', america: 'US',
  germany: 'DE', france: 'FR', india: 'IN',
};

function isoFrom(raw) {
  const s = clean(raw, 60).toLowerCase();
  if (!s) return '';
  if (/^[a-z]{2}$/.test(s) && Object.prototype.hasOwnProperty.call(ISO_TO_CC, s.toUpperCase())) {
    return s.toUpperCase();
  }
  return COUNTRY_NAMES[s] || '';
}

// ---------------------------------------------------------------------------
// Service, urgency and budget - derived deterministically, never by the model
// ---------------------------------------------------------------------------
// These three feed the score, and the score has to be reproducible and
// explainable, so all three are regex over text the lead actually wrote. The AI
// reads the same free text for a *qualitative* read and contributes zero
// points; see constants.js section 5.

// A word STEM must not be wrapped in a closing \b. `/\bautomat\b/` matches
// nothing, because "automation" has no boundary after "automat" - so the whole
// pattern silently never fires and every lead scores as service "unknown".
// It shipped that way for exactly one test run. Stems therefore end in \w*,
// and only whole words keep a closing \b.
//
// Order is priority: the first match wins, so the specific and high-value
// categories are listed before the generic ones.
const SERVICE_PATTERNS = [
  [/\b(rag|knowledge ?base|document (search|q ?& ?a)|vector (db|search|store)|semantic search)\b/i, 'rag'],
  [/\b(chat ?bots?|ai ?agents?|voice ?agents?|assistants?|copilots?|llms?)\b/i, 'ai_agent'],
  [/\b(automat\w*|n8n|zapier|make\.com|workflows?|أتمتة)/i, 'automation'],
  [/\b(integrat\w*|apis?|webhooks?|middleware|connectors?)\b/i, 'integration'],
  [/\b(web ?app|mobile ?app|portal|dashboard|platform|full[- ]?stack|saas|website)s?\b/i, 'custom_app'],
  [/\b(consult\w*|advis\w*|strateg\w*|roadmaps?)/i, 'consulting'],
  [/\b(audit\w*|assessments?|health ?check)/i, 'audit'],
  [/\b(train(ing|er|ers)?|workshops?|courses?|upskill\w*)\b/i, 'training'],
];

function normService(raw, freeText) {
  for (const text of [clean(raw, 200), clean(freeText, 600)]) {
    if (!text) continue;
    for (const [re, token] of SERVICE_PATTERNS) if (re.test(text)) return token;
  }
  return 'unknown';
}

// Same stem rule as SERVICE_PATTERNS above: "urgently" does not match
// /\burgent\b/.
const URGENCY_PATTERNS = [
  [/\b(asap|urgent\w*|immediat\w*|right away|this week|by (monday|tuesday|wednesday|thursday|friday)|today|tonight|deadline|ضروري|حالا)/i, 'immediate'],
  [/\b(this month|next month|this quarter|q[1-4] |within (a|one|two|2) months?|30 days|60 days|قريب)/i, 'this_quarter'],
  [/\b(explor\w*|research\w*|just looking|curious|no rush|someday|in the future|later|eventually)/i, 'exploring'],
];

function normUrgency(raw, freeText) {
  const direct = clean(raw, 40).toLowerCase().replace(/[\s-]+/g, '_');
  if (['immediate', 'this_quarter', 'exploring'].includes(direct)) return direct;
  for (const text of [clean(raw, 200), clean(freeText, 600)]) {
    if (!text) continue;
    for (const [re, token] of URGENCY_PATTERNS) if (re.test(text)) return token;
  }
  return 'unknown';
}

// Thresholds come from constants.js so intake and the scorer cannot disagree
// about what "high" means. Only an explicit amount or an explicit band counts:
// a number with no currency is NOT assumed to be dollars, because "budget: 50"
// is far more likely to be a typo or a headcount than fifty dollars, and a
// wrong budget band can move a lead across a qualification threshold.
const BUDGET = C.BUDGET_USD;

function normBudget(raw, freeText) {
  const direct = clean(raw, 40).toLowerCase();
  if (['high', 'mid', 'medium', 'low'].includes(direct)) return direct === 'medium' ? 'mid' : (direct === 'low' ? 'unknown' : direct);

  const scan = `${clean(raw, 200)} ${clean(freeText, 600)}`;
  // $12,000 / 12000 usd / 12k usd / usd 12000
  const m = scan.match(/(?:\$|\busd\s*)\s*([\d,.]+)\s*(k|m)?\b|\b([\d,.]+)\s*(k|m)?\s*(?:usd|dollars?|\$)\b/i);
  if (!m) return 'unknown';
  const num = parseFloat(String(m[1] || m[3] || '').replace(/,/g, ''));
  if (!isFinite(num) || num <= 0) return 'unknown';
  const mult = String(m[2] || m[4] || '').toLowerCase();
  const usd = num * (mult === 'k' ? 1000 : mult === 'm' ? 1000000 : 1);
  if (usd >= BUDGET.HIGH) return 'high';
  if (usd >= BUDGET.MID) return 'mid';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// finalizeLead - the one place a canonical lead is constructed
// ---------------------------------------------------------------------------

/**
 * @param p    source-mapped partial: full_name, email_raw, phone_raw, company,
 *             country, service_interest, free_text, consent, budget, urgency,
 *             source, source_ref, sub_source, raw
 * @param ctx  { now: epochSeconds, default_cc: '20' }
 */
function finalizeLead(p, ctx) {
  ctx = ctx || {};
  const now = Number(ctx.now || Math.floor(Date.now() / 1000));

  const full_name = clean(p.full_name, 120);
  const company = clean(p.company, 160);

  // --- email ---------------------------------------------------------------
  const email_raw = clean(p.email_raw, 200).toLowerCase();
  const email_valid = !!email_raw && C.EMAIL_RE.test(email_raw);
  const email_norm = email_valid ? C.normEmail(email_raw) : '';

  // --- phone ---------------------------------------------------------------
  // Country is resolved BEFORE the phone, because a stated country picks the
  // dialling code for a local-format number. Without that, a UAE lead writing
  // "0501234567" becomes an Egyptian number and lands in the wrong market band.
  const stated_country = isoFrom(p.country);
  const cc = ISO_TO_CC[stated_country] || String(ctx.default_cc || '20');

  const phone_raw = clean(p.phone_raw, 40);
  const phone_digits = phone_raw.replace(/\D/g, '');
  const phone_valid = phone_digits.length >= INTAKE.MIN_PHONE_DIGITS
    && phone_digits.length <= INTAKE.MAX_PHONE_DIGITS;
  const phone_e164 = phone_valid ? C.toE164(phone_raw, cc) : '';
  const phone_key = phone_valid ? C.phoneKey(phone_e164) : '';

  const country = stated_country || C.countryFromE164(phone_e164);

  // --- consent -------------------------------------------------------------
  // Three states, never two. "unknown" is not "denied" and it is not "granted";
  // it is a lead that has to be asked before anything is sent to it.
  let consent = 'unknown';
  if (truthy(p.consent)) consent = 'granted';
  else if (falsy(p.consent)) consent = 'denied';

  const free_text = clean(p.free_text, INTAKE.MAX_FREE_TEXT);
  const service_interest = normService(p.service_interest, free_text);

  const lead = {
    lead_uid: '',
    source: String(p.source || '').trim(),
    source_ref: clean(p.source_ref, 120),
    sub_source: clean(p.sub_source, 60),
    received_at: now,

    full_name,
    email_raw,
    email_norm,
    phone_raw,
    phone_e164,
    phone_key,
    country,
    company,
    domain: C.domainOf(email_norm),

    service_interest,
    urgency: normUrgency(p.urgency, free_text),
    budget_band: normBudget(p.budget, free_text),
    free_text,

    consent,
    consent_source: clean(p.consent_source, 40) || 'unspecified',

    // filled downstream by LP-02 and later
    score: 0,
    band: '',
    owner_id: '',
    odoo_lead_id: 0,
    status: 'active',

    raw_json: JSON.stringify(p.raw ?? {}).slice(0, INTAKE.MAX_RAW_JSON),
    updated_at: now,
  };

  // --- the two keys --------------------------------------------------------
  // person_key answers "have we met this human?"; idem_key answers "have we
  // already processed this delivery?". Conflating them is the classic intake
  // bug in both directions - see constants.js section 3.
  lead.person_key = C.personKeyOf(lead);
  lead.idem_key = C.intakeIdemKey(lead.source, lead.source_ref, lead.person_key, p.raw ?? p);
  lead.lead_uid = C.leadUidFrom(lead.idem_key, lead.received_at);

  const v = validateLead(lead);
  lead.validation_state = v.state;
  lead.validation_missing = v.missing.join(',');
  lead.validation_reason = v.reason;
  return lead;
}

/**
 * Four outcomes, and the difference between them is what the whole intake
 * routing hangs on:
 *
 *   ok          - complete enough to score
 *   incomplete  - reachable, but missing a critical field. Goes FORWARD, into
 *                 the Data Completion funnel stage. Not an error.
 *   unusable    - nobody to contact. Quarantined; there is no follow-up that
 *                 could ever recover it.
 *   parse_error - the row could not be read at all. Quarantined, with the raw
 *                 text kept so it can be fixed and replayed.
 */
function validateLead(lead) {
  const contactable = !!lead.email_norm || !!lead.phone_key;
  const missing = [];
  if (!lead.full_name) missing.push('full_name');
  if (!contactable) missing.push('contactable');
  if (lead.consent === 'unknown') missing.push('consent');

  if (!contactable) {
    return { state: 'unusable', missing, reason: 'no valid email and no valid phone - nothing to contact' };
  }
  if (missing.length) {
    return { state: 'incomplete', missing, reason: 'missing ' + missing.join(', ') };
  }
  return { state: 'ok', missing: [], reason: '' };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A real CSV reader, not a `split(',')`.
 *
 * Quoted fields, doubled quotes, embedded commas and newlines, CRLF, and a BOM
 * all appear in files exported from Excel, and every one of them turns a
 * `split(',')` import into silent data corruption - which is worse than a
 * failed import, because nobody notices.
 *
 * Errors are attached PER ROW. An unreadable row must not take the batch down
 * with it (edge case 13).
 */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) return { header: [], rows: [], error: 'the file is empty' };

  const header = nonEmpty[0].map((h) => clean(h, 60).toLowerCase());
  const out = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cells = nonEmpty[r];
    let error = '';
    if (cells.length !== header.length) {
      error = `expected ${header.length} columns, found ${cells.length}`;
    } else if (inQuotes && r === nonEmpty.length - 1) {
      error = 'unterminated quote - the rest of the file was swallowed into this row';
    }
    out.push({ line: r + 1, cells, error });
  }
  return { header, rows: out, error: '' };
}

// Header spellings seen in real exports. Anything unrecognised is ignored
// rather than guessed at, and unrecognised headers are reported back in the
// response so the importer can fix the file instead of wondering why a column
// had no effect.
const CSV_ALIASES = {
  full_name: ['full_name', 'full name', 'name', 'contact', 'contact name', 'customer', 'customer name', 'lead name', 'الاسم'],
  email_raw: ['email', 'e-mail', 'email address', 'mail', 'work email', 'الايميل', 'البريد'],
  phone_raw: ['phone', 'mobile', 'phone number', 'mobile number', 'tel', 'telephone', 'whatsapp', 'الموبايل', 'التليفون'],
  company: ['company', 'company name', 'organisation', 'organization', 'account', 'business', 'الشركة'],
  country: ['country', 'market', 'location', 'الدولة'],
  service_interest: ['service', 'service interest', 'interested in', 'product', 'offering', 'الخدمة'],
  free_text: ['notes', 'note', 'message', 'requirement', 'requirements', 'need', 'description', 'comments', 'ملاحظات'],
  consent: ['consent', 'opt_in', 'opt-in', 'optin', 'gdpr', 'marketing consent', 'subscribed'],
  budget: ['budget', 'budget usd', 'deal size', 'value'],
  urgency: ['urgency', 'timeline', 'timeframe', 'when'],
  sub_source: ['source', 'lead source', 'channel', 'campaign'],
  source_ref: ['id', 'row id', 'record id', 'external id', 'crm id'],
};

function csvHeaderMap(header) {
  const map = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(CSV_ALIASES)) {
    for (let i = 0; i < header.length; i++) {
      if (aliases.includes(header[i]) && !used.has(i)) { map[field] = i; used.add(i); break; }
    }
  }
  const unmapped = header.filter((h, i) => h && !used.has(i));
  return { map, unmapped };
}

function mapCsvRow(map, cells) {
  const at = (f) => (map[f] === undefined ? '' : cells[map[f]]);
  return {
    full_name: at('full_name'),
    email_raw: at('email_raw'),
    phone_raw: at('phone_raw'),
    company: at('company'),
    country: at('country'),
    service_interest: at('service_interest'),
    free_text: at('free_text'),
    consent: at('consent'),
    budget: at('budget'),
    urgency: at('urgency'),
    sub_source: at('sub_source'),
    source_ref: at('source_ref'),
  };
}

const I = {
  INTAKE, clean, truthy, falsy, ISO_TO_CC, COUNTRY_NAMES, isoFrom,
  SERVICE_PATTERNS, normService, URGENCY_PATTERNS, normUrgency, BUDGET, normBudget,
  finalizeLead, validateLead, parseCsv, CSV_ALIASES, csvHeaderMap, mapCsvRow,
};

if (typeof module !== 'undefined' && module.exports) module.exports = I;
