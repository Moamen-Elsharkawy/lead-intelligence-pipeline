/**
 * Lead Intelligence Pipeline - canonical constants.
 *
 * n8n Code nodes cannot import files, so the relevant slice of this file is
 * inlined into each node. THIS FILE IS THE SOURCE OF TRUTH: change it here
 * first, then propagate. Every inlined copy carries the comment
 * `// from _shared/constants.js` so the copies are greppable.
 *
 * Nothing here reads a secret. Per-deployment values live in each workflow's
 * `Config` node, because this n8n instance runs with
 * N8N_BLOCK_ENV_ACCESS_IN_NODE=true and $env throws.
 */

// ---------------------------------------------------------------------------
// 1. Canonical lead schema
// ---------------------------------------------------------------------------
// Every source is normalised into exactly this shape before anything else
// looks at it. `raw_json` keeps the original payload so a replay can prove
// what actually arrived.

const LEAD_SCHEMA = {
  lead_uid: 'string', // LP-<yyyymmdd>-<8 hex>, generated once at intake
  source: 'string', // website | whatsapp | csv_import
  source_ref: 'string', // provider id when the source gives one (wamid, form id, csv row)
  received_at: 'number', // epoch seconds
  full_name: 'string',
  email_raw: 'string',
  email_norm: 'string', // lowercased, gmail dots/plus-tags folded
  phone_raw: 'string',
  phone_e164: 'string', // +<cc><national>, digits only after the +
  phone_key: 'string', // trailing 10 digits, the comparison key
  country: 'string', // ISO-2, derived from the E.164 prefix when not supplied
  company: 'string',
  domain: 'string', // from email_norm when it is not a free provider
  service_interest: 'string',
  free_text: 'string', // the "what do you need" blob the AI reads
  consent: 'string', // granted | denied | unknown
  consent_source: 'string', // form_checkbox | inbound_initiated | import_attested
  // --- filled downstream ---
  score: 'number',
  score_breakdown_json: 'string',
  band: 'string', // vip | qualified | nurture | unqualified | data_completion | manual_review
  ai_status: 'string', // ok | unavailable | skipped
  ai_intent: 'string', // high | medium | low
  ai_urgency: 'string',
  ai_signals: 'string',
  ai_reason: 'string',
  ai_confidence: 'number',
  owner_id: 'string',
  assign_rung: 'number', // which fallback rung assigned it, 1..3
  odoo_lead_id: 'number',
  odoo_stage: 'string',
  approval_state: 'string', // not_required | pending | approved | rejected
  approval_by: 'string',
  status: 'string', // active | merged | closed
  merged_into: 'string', // lead_uid of the survivor, when this one lost a dedupe
  raw_json: 'string',
  updated_at: 'number',
};

// Critical fields. Missing any of these routes to the Data Completion path
// instead of scoring. `service_interest` is deliberately NOT critical: it is
// recoverable from free text and from the follow-up conversation, and making
// it critical sent most WhatsApp leads to a human for no reason.
const CRITICAL_FIELDS = ['full_name', 'contactable', 'consent'];
// `contactable` is satisfied by EITHER a valid email OR a valid phone.

// ---------------------------------------------------------------------------
// 2. Normalisation
// ---------------------------------------------------------------------------

// Country dial prefixes, longest-first so +1868 beats +1.
// Only the markets this business actually sees; everything else resolves to ''.
const DIAL_PREFIXES = [
  ['971', 'AE'], ['966', 'SA'], ['974', 'QA'], ['965', 'KW'], ['973', 'BH'],
  ['968', 'OM'], ['962', 'JO'], ['961', 'LB'], ['212', 'MA'], ['216', 'TN'],
  ['213', 'DZ'], ['249', 'SD'], ['218', 'LY'], ['964', 'IQ'],
  ['20', 'EG'], ['44', 'GB'], ['49', 'DE'], ['33', 'FR'], ['91', 'IN'],
  ['1', 'US'],
];

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
  'yandex.com', 'mail.com', 'gmx.com',
]);

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com',
  'throwaway.email', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
]);

/**
 * Digits-only, then take the trailing 10 as the comparison key.
 * Ported from projects/accounts/belal/tooling/contacts-parser/parse_contacts.py,
 * where it deduped 23.5k real contacts down to 12,866. The trailing-10 rule is
 * what makes "01012345678", "+201012345678" and "0020 101 234 5678" one person.
 */
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

/**
 * Best-effort E.164. `defaultCc` is the deployment's home country, used only
 * when the number carries no international prefix of its own.
 */
function toE164(raw, defaultCc = '20') {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  // A local number: drop the trunk 0 and prepend the home country code.
  if (d.startsWith('0')) d = defaultCc + d.slice(1);
  // Already-national length with no country code at all.
  else if (d.length <= 10) d = defaultCc + d;
  return '+' + d;
}

function countryFromE164(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  for (const [pfx, iso] of DIAL_PREFIXES) if (d.startsWith(pfx)) return iso;
  return '';
}

/**
 * Fold an email to a comparison key. Gmail ignores dots and everything after
 * a plus, so a.b+lead@gmail.com and ab@gmail.com are the same inbox - and the
 * same person submitting twice.
 */
function normEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  let [user, domain] = [s.slice(0, at), s.slice(at + 1)];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') user = user.split('+')[0].replace(/\./g, '');
  else user = user.split('+')[0];
  return `${user}@${domain}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

function domainOf(emailNorm) {
  const d = String(emailNorm || '').split('@')[1] || '';
  return FREE_EMAIL_DOMAINS.has(d) ? '' : d;
}

// ---------------------------------------------------------------------------
// 3. Identity and idempotency - two different things
// ---------------------------------------------------------------------------
// `idem_key` identifies an EVENT: "has this exact delivery been processed?"
// `person_key` identifies a HUMAN: "have we met this person before?"
// The same person arriving on WhatsApp and the website produces two different
// event keys, both correctly accepted, and one person key that decides which
// lead record survives. Conflating them is the classic bug: dedupe by event
// key and the second source is silently dropped; dedupe by person key and a
// retried webhook overwrites good data.

const IDEM_SCOPES = ['intake', 'odoo_upsert', 'message', 'booking', 'approval'];

/**
 * FNV-1a 64-bit in BigInt: exact, dependency-free, and identical in a Code
 * node and in `node scripts/*`. Not a security hash and not used as one.
 */
function stableHash(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Key order must not change the hash, so serialise with sorted keys. */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/**
 * Stable across retries, distinct across genuinely separate submissions.
 *
 * A provider id is always preferred. When there is none, the key is a hash of
 * the submission's own content - NOT a time bucket. Time bucketing was the
 * first design and it is fragile at the boundary: two clicks five seconds
 * apart can straddle a bucket edge and both be accepted, which is exactly the
 * duplicate the gate exists to stop. A content hash has no boundary.
 *
 * The accepted trade-off: a person who submits a byte-identical form twice a
 * week apart is treated as one event. That is the correct reading of an
 * identical request, and the second delivery still writes an
 * `intake_duplicate_event` audit row, so it is visible rather than silent.
 */
function intakeIdemKey(source, sourceRef, personKey, payload) {
  if (sourceRef) return `intake:${source}:${sourceRef}`;
  return `intake:${source}:${personKey}:${stableHash(canonicalJson(payload))}`;
}

/** Deterministic, so a replay of the same event rebuilds the same id. */
function leadUidFrom(idemKey, receivedAtSec) {
  const d = new Date(Number(receivedAtSec || 0) * 1000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `LP-${ymd}-${stableHash(idemKey).slice(0, 8).toUpperCase()}`;
}

function personKeyOf(lead) {
  return lead.phone_key || lead.email_norm || `uid:${lead.lead_uid}`;
}

// ---------------------------------------------------------------------------
// 4. Duplicate confidence
// ---------------------------------------------------------------------------
// Never delete. High confidence merges into the survivor; medium raises a
// manual-review case; low is treated as a new person.

const DUP = {
  HIGH: 0.9, // phone_key match, or email_norm match
  MEDIUM: 0.6, // same normalised name + same company, different contact details
};

function dupConfidence(a, b) {
  if (a.phone_key && a.phone_key === b.phone_key) return { score: 1.0, on: 'phone_key' };
  if (a.email_norm && a.email_norm === b.email_norm) return { score: 0.95, on: 'email_norm' };
  const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (n(a.full_name) && n(a.full_name) === n(b.full_name)) {
    if (n(a.company) && n(a.company) === n(b.company)) return { score: 0.75, on: 'name+company' };
    if (a.domain && a.domain === b.domain) return { score: 0.7, on: 'name+domain' };
    return { score: 0.4, on: 'name only' };
  }
  return { score: 0, on: 'none' };
}

// ---------------------------------------------------------------------------
// 5. Deterministic scoring
// ---------------------------------------------------------------------------
// The AI contributes ZERO points. If the whole AI layer is deleted, every
// lead still scores, routes, assigns and syncs. That separation is what makes
// requirement D's "deterministic score" and "separate qualitative
// classification" two genuinely independent axes rather than one dressed up
// as two.
//
// Every `unknown` band is worth real points, not zero. A WhatsApp lead has no
// email, therefore no domain, therefore no enrichment - and with zero-valued
// unknowns the arithmetic made it structurally impossible for any WhatsApp
// lead to reach 70. For a brief whose scenario centres on WhatsApp, that is a
// scoring bug, not a scoring policy.

const SCORE = {
  company_size: { '201+': 20, '51-200': 16, '11-50': 12, '1-10': 6, unknown: 12 },
  industry: { target: 15, adjacent: 8, unknown: 10 }, // `excluded` disqualifies outright
  market: { core: 10, adjacent: 6, unknown: 5, other: 2 },
  service: { high: 25, mid: 15, low: 5, unknown: 5 },
  urgency: { immediate: 10, this_quarter: 6, exploring: 2, unknown: 2 },
  completeness: { both: 6, one: 3 },
  source: { referral: 5, website: 5, whatsapp: 4, paid_social: 2, csv_import: 1 },
  budget: { high: 14, mid: 7, unknown: 0 },
  penalty: { competitor_or_jobseeker: -20, disposable_email: -10 },
  MAX: 100,
};

// Budget bands, in USD, defined ONCE. They were briefly defined twice - the
// scorer bucketed an amount and intake banded the same amount against different
// numbers - so the same lead could score differently depending on which path it
// arrived by. A threshold with two homes is a threshold that will disagree with
// itself.
const BUDGET_USD = { HIGH: 5000, MID: 1000 };

const TARGET_INDUSTRIES = ['technology', 'professional services', 'real estate', 'healthcare', 'education', 'logistics'];
const ADJACENT_INDUSTRIES = ['retail', 'manufacturing', 'hospitality', 'construction'];
// Out-of-scope verticals. Every agency has them; keeping the list as data
// rather than a hardcoded branch means changing it is a config edit.
const EXCLUDED_INDUSTRIES = ['gambling', 'alcohol', 'tobacco', 'adult', 'lending'];

const CORE_MARKETS = ['EG', 'AE', 'SA'];
const ADJACENT_MARKETS = ['QA', 'KW', 'BH', 'OM', 'JO'];

const HIGH_VALUE_SERVICES = ['automation', 'ai_agent', 'rag', 'integration', 'custom_app'];
const MID_VALUE_SERVICES = ['consulting', 'audit', 'training'];

const DISQUALIFY_PATTERNS = /\b(job|vacanc|hiring|cv|resume|internship|student|thesis|competitor|partnership offer|guest post|seo services|link building)\b/i;

// ---------------------------------------------------------------------------
// 6. Bands - the brief's business rules, verbatim
// ---------------------------------------------------------------------------

const BANDS = {
  VIP: { min: 90, label: 'vip' }, // or the strategic-account flag
  QUALIFIED: { min: 70, label: 'qualified' },
  NURTURE: { min: 40, label: 'nurture' },
  UNQUALIFIED: { min: 0, label: 'unqualified' },
};

function bandFor(score, strategic) {
  if (strategic || score >= 90) return 'vip';
  if (score >= 70) return 'qualified';
  if (score >= 40) return 'nurture';
  return 'unqualified';
}

// Ordinal distance is what the AI-vs-rules conflict rule compares.
const BAND_ORDINAL = { unqualified: 0, nurture: 1, qualified: 2, vip: 2 };

// ---------------------------------------------------------------------------
// 7. The AI contract
// ---------------------------------------------------------------------------

const AI_SCHEMA = {
  intent_level: 'high | medium | low',
  urgency: 'immediate | this_quarter | exploring | unknown',
  buying_signals: 'string[] , at most 3',
  reason: 'string, at most 200 chars, quoting the lead not inventing',
  confidence: 'number 0..1',
};

const AI_IMPLIED_BAND = { high: 'qualified', medium: 'nurture', low: 'unqualified' };

const CONFLICT = {
  MIN_CONFIDENCE: 0.7,
  MIN_BAND_DISTANCE: 2,
};

/**
 * "Materially conflicts" made numeric, because a reviewer will ask what
 * material means. One clause, two constants.
 *
 * Adjacent disagreement (qualified vs nurture) is expected noise around a cut
 * point and must NOT trigger review, or the manual queue becomes the default
 * path and the automation has achieved nothing.
 */
function materiallyConflicts(ruleBand, ai) {
  if (!ai || ai.ai_status !== 'ok') return false;
  if (Number(ai.ai_confidence) < CONFLICT.MIN_CONFIDENCE) return false;
  const aiBand = AI_IMPLIED_BAND[ai.ai_intent];
  if (!aiBand) return false;
  return Math.abs(BAND_ORDINAL[aiBand] - BAND_ORDINAL[ruleBand]) >= CONFLICT.MIN_BAND_DISTANCE;
}

// ---------------------------------------------------------------------------
// 8. Assignment - three rungs, then stop
// ---------------------------------------------------------------------------
// Deterministic so it is testable: least loaded first, ties broken by agent_id
// rather than by whatever order the table happened to return.

const ASSIGN_RUNGS = [
  'available AND handles the service category',
  'available, any category',
  'fallback owner, and raise an alert',
];

function pickOwner(agents, service, fallbackOwnerId) {
  const load = (a) => Number(a.open_leads || 0) / Math.max(1, Number(a.capacity || 1));
  const byLoad = (x, y) => load(x) - load(y) || String(x.agent_id).localeCompare(String(y.agent_id));
  // The fallback owner is the safety net, not a member of the rotation. They
  // are usually the sales manager: high capacity and every service category,
  // which on an idle roster means a low load ratio and a winning tie-break, so
  // leaving them in the pool quietly makes the manager the default owner of
  // everything. Rung 3 is where they belong, and rung 3 raises an alert.
  const free = agents.filter((a) => a.available
    && Number(a.open_leads) < Number(a.capacity)
    && String(a.agent_id) !== String(fallbackOwnerId));
  const matched = free.filter((a) => String(a.services || '').split(',').map((s) => s.trim()).includes(service));
  if (matched.length) return { agent_id: matched.sort(byLoad)[0].agent_id, rung: 1 };
  if (free.length) return { agent_id: free.sort(byLoad)[0].agent_id, rung: 2 };
  return { agent_id: fallbackOwnerId, rung: 3, alert: true };
}

// ---------------------------------------------------------------------------
// 9. Odoo stage map
// ---------------------------------------------------------------------------
// Lost is NOT a stage. In Odoo it is active=false + probability=0 + a lost
// reason, which is why every duplicate search must pass {active_test: false}:
// without it a previously-lost lead is invisible and gets created again.

const STAGES = {
  NEW: 'New',
  DATA_COMPLETION: 'Data Completion',
  MANUAL_REVIEW: 'Manual Review',
  AWAITING_APPROVAL: 'Awaiting Approval',
  QUALIFIED: 'Qualified',
  NURTURE: 'Nurture',
  CONTACTED: 'Proposition',
  BOOKED: 'Meeting Booked',
  WON: 'Won',
};

// Stages Odoo does not ship with, created by LP-00 Setup.
const STAGES_TO_CREATE = [
  { name: 'Data Completion', sequence: 5 },
  { name: 'Manual Review', sequence: 6 },
  { name: 'Awaiting Approval', sequence: 7 },
  { name: 'Nurture', sequence: 8 },
  { name: 'Meeting Booked', sequence: 30 },
];

// Business event -> the stage the opportunity moves to. This table IS the
// "dynamic sales funnel" requirement; nothing moves a stage except a lookup
// in here, so the funnel behaviour is one readable object rather than
// conditionals scattered across nine workflows.
const STAGE_TRANSITIONS = {
  lead_created: STAGES.NEW,
  missing_critical_data: STAGES.DATA_COMPLETION,
  duplicate_ambiguous: STAGES.MANUAL_REVIEW,
  ai_rule_conflict: STAGES.MANUAL_REVIEW,
  vip_pending_approval: STAGES.AWAITING_APPROVAL,
  vip_approved: STAGES.QUALIFIED,
  qualified_assigned: STAGES.QUALIFIED,
  nurture_assigned: STAGES.NURTURE,
  confirmation_sent: STAGES.CONTACTED,
  meeting_booked: STAGES.BOOKED,
  converted: STAGES.WON,
};

// Events that close a lead instead of moving it. Handled as active=false.
const LOST_REASONS = {
  vip_rejected: 'Rejected by manager',
  opted_out: 'Opted out',
  unqualified_closed: 'Below qualification threshold',
  sequence_exhausted: 'No response after full sequence',
  duplicate_merged: 'Merged into an existing opportunity',
};

// ---------------------------------------------------------------------------
// 10. Follow-up cadence
// ---------------------------------------------------------------------------
// Three steps with three genuinely different conditions: a relative-hours
// delay, a relative-days delay, and a score-conditional step.

const CADENCE = {
  qualified: [
    { step: 1, delay_s: 3600, template: 'q_fu1', condition: 'always' },
    { step: 2, delay_s: 86400, template: 'q_fu2', condition: 'always' },
    { step: 3, delay_s: 259200, template: 'q_fu3', condition: 'score>=85' },
  ],
  nurture: [
    { step: 1, delay_s: 172800, template: 'n_fu1', condition: 'always' },
    { step: 2, delay_s: 604800, template: 'n_fu2', condition: 'always' },
    { step: 3, delay_s: 1814400, template: 'n_fu3', condition: 'always' },
  ],
};

const SLA_SECONDS = 1800; // 30 minutes, per the brief's SLA Breach rule

// Any of these cancels every pending job for the lead, immediately.
const STOP_REASONS = ['replied', 'booked', 'opted_out', 'closed', 'merged'];

// ---------------------------------------------------------------------------
// 11. Retry policy
// ---------------------------------------------------------------------------
// Capped at 8s, not 60s: the gateway is called with waitForSubWorkflow, so a
// long backoff holds the caller open and can blow a webhook response window.
// Bounded by tries AND by total elapsed, so no path can loop forever.

const RETRY = {
  MAX_TRIES: 3,
  BASE_MS: 500,
  CAP_MS: 8000,
  JITTER: 0.25,
  RETRYABLE_STATUS: [408, 425, 429, 500, 502, 503, 504],
  // Anything else is permanent and goes straight to the dead-letter queue.
};

/**
 * Exponential backoff with jitter, clamped LAST.
 *
 * The obvious ordering - cap, then jitter - is wrong: +/-25% applied after the
 * cap returns up to 10s from an "8s cap", so the cap is not a cap. A flaky
 * unit test caught this, which is the only reason it is not in the shipped
 * workflows.
 */
function backoffMs(attempt) {
  const raw = RETRY.BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jittered = raw * (1 - RETRY.JITTER + Math.random() * RETRY.JITTER * 2);
  return Math.max(RETRY.BASE_MS, Math.min(RETRY.CAP_MS, Math.round(jittered)));
}

// ---------------------------------------------------------------------------
// 11b. Error classification
// ---------------------------------------------------------------------------
// Three classes, because they have three different responses: `transient`
// means wait, `credential` means a human has to log in somewhere, `permanent`
// means the input or the code is wrong and retrying is pointless.
//
// This lived inline in LP-05's Code node, which is precisely why it shipped
// wrong. n8n's task runner fails with "Task request timed out after 60
// seconds" - two words - and the transient pattern only had `timeout` and
// `etimedout`, so the single most retryable failure on this instance fell
// through to the `permanent` default. That misclassification alerts on
// something that should retry quietly AND tells the operator reading the dead
// letter not to retry, which is the opposite of the truth.
//
// It is here now for the same reason the scorer and the intake are here: the
// code most likely to be wrong is the code that has to be unit-testable
// outside n8n. See scripts/test-errors.js.

const ERROR_PATTERNS = {
  credential: /unauthori[sz]ed|\b401\b|\b403\b|forbidden|invalid.{0,12}(credential|api key|token)|token.{0,12}expired|refresh token|authentication failed|access denied/i,
  // `timed\s*out` is NOT redundant beside `timeout`: they are different
  // strings, and the two-word form is the one n8n's own runner emits.
  transient: /econnrefused|etimedout|enotfound|socket hang up|network|timeout|timed\s*out|\b429\b|\b50[234]\b|rate.?limit|temporarily unavailable|serializationfailure|could not serialize/i,
};

/**
 * @param {string} message  the error message
 * @param {string} name     the error name/type, if any
 * @returns {{error_class: 'credential'|'transient'|'permanent', severity: 'critical'|'warning'|'error'}}
 */
function classifyError(message, name) {
  const sig = (String(message || '') + ' ' + String(name || '')).toLowerCase();
  // Credential is tested first and wins ties. A 401 that also mentions a
  // timeout is a dead credential, not a slow network, and treating it as
  // transient is how a frozen pipeline stays quiet for 25 days.
  if (ERROR_PATTERNS.credential.test(sig)) return { error_class: 'credential', severity: 'critical' };
  if (ERROR_PATTERNS.transient.test(sig)) return { error_class: 'transient', severity: 'warning' };
  return { error_class: 'permanent', severity: 'error' };
}

// ---------------------------------------------------------------------------
// 12. Data tables - THE ONLY definition of the schema
// ---------------------------------------------------------------------------
// Eight tables. Column types are string | number | boolean | date; there is no
// JSON column, so payloads are stored as JSON strings. Timestamps are epoch
// SECONDS in number columns, because numeric comparison is the one filter
// semantics that is unambiguous here and the tick's `due_at <= now` depends
// on it.
//
// THIS IS THE SINGLE SOURCE. scripts/create-tables.js builds the tables from
// exactly this object and nothing else.
//
// It was not always. The column list lived here AND, separately, in
// create-tables.js - and the two drifted, in the quiet way a duplicated
// definition always does. The real table carried `stated_urgency` and
// `stated_budget`, names retired weeks earlier when the scorer and the intake
// were unified on `urgency` and `budget_band`; the live names had never been
// stored at all. Nothing failed, because writing a column that does not exist
// is only an error if you write it, and nothing did. Two dead columns and two
// missing ones, invisible until a test asserted on a field and read undefined.
//
// A schema with two homes is a schema that will disagree with itself.

const T_S = 'string';
const T_N = 'number';
const T_B = 'boolean';

const TABLES = {
  lp_config: { key: T_S, value: T_S, note: T_S },

  lp_lead: {
    lead_uid: T_S, source: T_S, source_ref: T_S, received_at: T_N,
    full_name: T_S, email_raw: T_S, email_norm: T_S,
    phone_raw: T_S, phone_e164: T_S, phone_key: T_S,
    country: T_S, company: T_S, domain: T_S,
    service_interest: T_S, urgency: T_S, budget_band: T_S, free_text: T_S,
    consent: T_S, consent_source: T_S,
    score: T_N, score_breakdown_json: T_S, band: T_S,
    ai_status: T_S, ai_intent: T_S, ai_urgency: T_S, ai_signals: T_S, ai_reason: T_S, ai_confidence: T_N,
    owner_id: T_S, assign_rung: T_N, odoo_lead_id: T_N, odoo_stage: T_S,
    approval_state: T_S, approval_by: T_S,
    status: T_S, merged_into: T_S, raw_json: T_S, updated_at: T_N,
  },

  // The idempotency ledger. One row per claimed side effect, every scope.
  lp_idem: {
    idem_key: T_S, scope: T_S, lead_uid: T_S, state: T_S, result_ref: T_S,
    claimed_at: T_N, completed_at: T_N, attempts: T_N,
  },

  // Identity, a different question from idempotency: idem_key asks "have we
  // processed this event?", person_key asks "have we met this human?".
  lp_person_index: {
    person_key: T_S, lead_uid: T_S, email_norm: T_S, phone_key: T_S, created_at: T_N,
  },

  lp_jobs: {
    job_id: T_S, lead_uid: T_S, job_type: T_S, step: T_N, template: T_S,
    due_at: T_N, state: T_S, attempts: T_N, claimed_at: T_N, result: T_S, cancel_reason: T_S,
  },

  lp_agents: {
    agent_id: T_S, name: T_S, email: T_S, services: T_S,
    capacity: T_N, open_leads: T_N, available: T_B, odoo_user_id: T_N,
  },

  // The audit trail. n8n's execution log is not one: it is pruned on a
  // schedule and cannot be queried by lead.
  lp_audit: {
    event_id: T_S, lead_uid: T_S, ts: T_N, workflow: T_S, execution_id: T_S,
    type: T_S, decision: T_S, detail_json: T_S,
  },

  lp_dlq: {
    dlq_id: T_S, lead_uid: T_S, stage_failed: T_S, error_class: T_S, error: T_S,
    payload_json: T_S, attempts: T_N, state: T_S, first_seen: T_N, last_seen: T_N,
  },
};

// The audit log is the audit trail. n8n's own execution log is not: it is
// pruned (14 days by default) and it is not queryable by lead.
const AUDIT_TYPES = [
  'intake_received', 'intake_duplicate_event', 'validation_failed', 'duplicate_decision',
  'enrichment', 'scored', 'ai_classified', 'ai_fallback', 'conflict_detected', 'banded',
  'assigned', 'odoo_upserted', 'stage_changed', 'message_sent', 'message_suppressed',
  'job_scheduled', 'job_cancelled', 'sla_breached', 'approval_requested', 'approval_decided',
  'error', 'replayed',
];

// `C` is the namespace the inlined copy uses inside n8n Code nodes. The build
// step concatenates this file into each node that needs it and strips the
// `require` from scorer.js, so `C` is already in scope there. Guarding the
// CommonJS export keeps the same file loadable by the test runner.
const C = {
  LEAD_SCHEMA, CRITICAL_FIELDS, DIAL_PREFIXES, FREE_EMAIL_DOMAINS, DISPOSABLE_EMAIL_DOMAINS,
  phoneKey, toE164, countryFromE164, normEmail, EMAIL_RE, domainOf,
  IDEM_SCOPES, intakeIdemKey, personKeyOf, stableHash, canonicalJson, leadUidFrom, DUP, dupConfidence,
  SCORE, BUDGET_USD, TARGET_INDUSTRIES, ADJACENT_INDUSTRIES, EXCLUDED_INDUSTRIES, CORE_MARKETS,
  ADJACENT_MARKETS, HIGH_VALUE_SERVICES, MID_VALUE_SERVICES, DISQUALIFY_PATTERNS,
  BANDS, bandFor, BAND_ORDINAL, AI_SCHEMA, AI_IMPLIED_BAND, CONFLICT, materiallyConflicts,
  ASSIGN_RUNGS, pickOwner, STAGES, STAGES_TO_CREATE, STAGE_TRANSITIONS, LOST_REASONS,
  CADENCE, SLA_SECONDS, STOP_REASONS, RETRY, backoffMs, ERROR_PATTERNS, classifyError,
  TABLES, AUDIT_TYPES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = C;
