/**
 * Scoring and routing unit tests. Run: node scripts/test-scoring.js
 *
 * These exist because the scoring table is the part of the system most likely
 * to be quietly wrong: it is arithmetic with no runtime error to catch it. The
 * WhatsApp persona below is the specific bug this suite was written for - with
 * zero-valued `unknown` bands, no WhatsApp lead could reach 70, which would
 * have failed the brief's own scenario silently.
 */
const C = require('../02_Workflows/_shared/constants.js');
const { scoreLead } = require('../02_Workflows/_shared/scorer.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

function band(lead, enrich) {
  const r = scoreLead(lead, enrich);
  return `${r.band}(${r.score})`;
}

console.log('--- personas -------------------------------------------------');

// The bug this suite exists for. No email, therefore no domain, therefore no
// enrichment at all. Country comes only from the phone prefix.
const waStrong = {
  source: 'whatsapp', full_name: 'Sara Adel', phone_key: '1012345678',
  phone_e164: '+201012345678', country: C.countryFromE164('+201012345678'),
  email_norm: '', service_interest: 'automation', urgency: 'immediate',
  free_text: 'We need to automate our lead follow-up, our sales team is drowning.',
};
const waStrongR = scoreLead(waStrong, {});
console.log('  whatsapp-strong breakdown:', waStrongR.breakdown.map((b) => `${b.factor}=${b.points}`).join(' '));
check('WhatsApp strong lead reaches Qualified', waStrongR.band, 'qualified');
check('  ...and its country came from the dial prefix', waStrong.country, 'EG');

const waWeak = {
  source: 'whatsapp', full_name: 'Karim T', phone_key: '1122334455',
  phone_e164: '+201122334455', country: 'EG', email_norm: '',
  service_interest: 'training', urgency: 'exploring', free_text: 'just asking about prices',
};
// 12 size-unknown + 10 industry-unknown + 10 core market + 15 mid-value
// service + 2 exploring + 3 phone-only + 4 whatsapp + 0 budget = 56.
check('WhatsApp browsing lead lands in Nurture', band(waWeak, {}), 'nurture(56)');

const webVip = {
  source: 'website', full_name: 'Nadia Fouad', email_norm: 'nadia@acme-logistics.com',
  phone_key: '1098765432', phone_e164: '+201098765432', country: 'EG',
  domain: 'acme-logistics.com', service_interest: 'rag', urgency: 'immediate',
  budget_band: '$12,000', free_text: 'We want a RAG assistant over our shipping docs this quarter.',
};
const webVipR = scoreLead(webVip, { company_size: 400, industry: 'logistics', country: 'EG', strategic: false });
check('Enriched enterprise website lead reaches VIP', webVipR.band, 'vip');

const webMid = {
  source: 'website', full_name: 'Omar S', email_norm: 'omar@smallshop.com',
  phone_key: '1055555555', country: 'EG', domain: 'smallshop.com',
  service_interest: 'consulting', urgency: 'this_quarter', budget_band: '$1,500',
};
check('Mid website lead lands in Qualified', band(webMid, { company_size: 80, industry: 'retail', country: 'EG' }), 'qualified(73)');

const webWeak = {
  source: 'csv_import', full_name: 'Test Person', email_norm: 'x@tinyco.io',
  country: 'GB', domain: 'tinyco.io', service_interest: 'newsletter', urgency: 'exploring',
};
// 6 micro-company + 8 adjacent industry + 2 non-core market + 5 low-value ask
// + 2 exploring + 3 email-only + 1 cold import + 0 budget = 27.
check('Cold import with a low-value ask is Unqualified', band(webWeak, { company_size: 4, industry: 'retail', country: 'GB' }), 'unqualified(27)');

const jobSeeker = {
  source: 'website', full_name: 'Applicant', email_norm: 'me@gmail.com', phone_key: '1000000001',
  country: 'EG', service_interest: 'automation', urgency: 'immediate',
  free_text: 'I am a student looking for an internship, attaching my CV.',
};
const jsR = scoreLead(jobSeeker, {});
check('Job seeker is penalised below Qualified', jsR.band === 'qualified', false);

const gambling = scoreLead(webVip, { company_size: 400, industry: 'Online gambling', country: 'EG' });
check('Excluded vertical is hard-disqualified', `${gambling.band}(${gambling.score})`, 'unqualified(0)');
check('  ...and says why', gambling.disqualified, true);

const strategic = scoreLead(webWeak, { company_size: 4, industry: 'retail', country: 'GB', strategic: true });
check('Strategic flag forces VIP regardless of score', strategic.band, 'vip');

const disposable = scoreLead(
  { ...webMid, email_norm: 'omar@mailinator.com' },
  { company_size: 80, industry: 'retail', country: 'EG' },
);
check('Disposable inbox costs 10 points', disposable.score, 63);

console.log('\n--- band thresholds match the brief ---------------------------');
check('90 is VIP', C.bandFor(90, false), 'vip');
check('89 is Qualified', C.bandFor(89, false), 'qualified');
check('70 is Qualified', C.bandFor(70, false), 'qualified');
check('69 is Nurture', C.bandFor(69, false), 'nurture');
check('40 is Nurture', C.bandFor(40, false), 'nurture');
check('39 is Unqualified', C.bandFor(39, false), 'unqualified');

console.log('\n--- AI vs rules conflict (edge case 5) ------------------------');
const aiHigh = { ai_status: 'ok', ai_intent: 'high', ai_confidence: 0.9 };
check('AI high vs rules unqualified is a material conflict', C.materiallyConflicts('unqualified', aiHigh), true);
check('AI high vs rules qualified is NOT a conflict', C.materiallyConflicts('qualified', aiHigh), false);
check('AI high vs rules nurture is NOT a conflict (adjacent)', C.materiallyConflicts('nurture', aiHigh), false);
check('Low confidence never conflicts', C.materiallyConflicts('unqualified', { ...aiHigh, ai_confidence: 0.5 }), false);
check('Unavailable AI never conflicts', C.materiallyConflicts('unqualified', { ai_status: 'unavailable' }), false);
check('AI low vs rules vip is a material conflict',
  C.materiallyConflicts('vip', { ai_status: 'ok', ai_intent: 'low', ai_confidence: 0.8 }), true);

console.log('\n--- normalisation (edge case 2) -------------------------------');
check('+20 101 234 5678 and 01012345678 share a phone key',
  C.phoneKey('+20 101 234 5678') === C.phoneKey('01012345678'), true);
check('0020-101-234-5678 too', C.phoneKey('0020-101-234-5678'), '1012345678');
check('local number becomes E.164', C.toE164('01012345678'), '+201012345678');
check('international number is preserved', C.toE164('+971501234567'), '+971501234567');
check('UAE prefix resolves', C.countryFromE164('+971501234567'), 'AE');
check('gmail dots and plus tags fold', C.normEmail('A.B+lead@Gmail.com'), 'ab@gmail.com');
check('other providers keep dots', C.normEmail('a.b@acme.com'), 'a.b@acme.com');
check('free provider yields no company domain', C.domainOf('ab@gmail.com'), '');
check('company domain is extracted', C.domainOf('nadia@acme-logistics.com'), 'acme-logistics.com');

console.log('\n--- duplicate confidence (edge case 1) ------------------------');
const a = { phone_key: '1012345678', email_norm: 'sara@acme.com', full_name: 'Sara Adel', company: 'Acme', domain: 'acme.com' };
check('same phone is high confidence', C.dupConfidence(a, { ...a, email_norm: 'other@x.com' }).score >= C.DUP.HIGH, true);
check('same email is high confidence', C.dupConfidence({ ...a, phone_key: '' }, { ...a, phone_key: '9999999999' }).score >= C.DUP.HIGH, true);
check('name+company only is medium', C.dupConfidence(
  { full_name: 'Sara Adel', company: 'Acme' }, { full_name: 'sara  adel', company: 'ACME' }).score, 0.75);
check('name alone is below the review floor', C.dupConfidence(
  { full_name: 'Sara Adel' }, { full_name: 'Sara Adel' }).score < C.DUP.MEDIUM, true);
check('nothing in common is zero', C.dupConfidence({ full_name: 'A' }, { full_name: 'B' }).score, 0);

console.log('\n--- idempotency keys ------------------------------------------');
const p1 = { name: 'Sara', email: 'sara@acme.com', msg: 'need automation' };
const p1reordered = { msg: 'need automation', email: 'sara@acme.com', name: 'Sara' };
const p2 = { name: 'Sara', email: 'sara@acme.com', msg: 'following up on my last note' };

check('provider id wins when present', C.intakeIdemKey('whatsapp', 'wamid.X', 'k', p1), 'intake:whatsapp:wamid.X');
check('identical resubmission collapses to one key',
  C.intakeIdemKey('website', '', 'k', p1) === C.intakeIdemKey('website', '', 'k', p1), true);
check('key order in the payload does not change the key',
  C.intakeIdemKey('website', '', 'k', p1) === C.intakeIdemKey('website', '', 'k', p1reordered), true);
check('a genuinely different enquiry gets its own key',
  C.intakeIdemKey('website', '', 'k', p1) === C.intakeIdemKey('website', '', 'k', p2), false);
check('different sources never collide',
  C.intakeIdemKey('website', '', 'k', p1) === C.intakeIdemKey('whatsapp', '', 'k', p1), false);
check('different people never collide',
  C.intakeIdemKey('website', '', 'k1', p1) === C.intakeIdemKey('website', '', 'k2', p1), false);
check('lead_uid is deterministic for the same event',
  C.leadUidFrom('intake:website:abc', 1786370400) === C.leadUidFrom('intake:website:abc', 1786370400), true);
check('lead_uid shape is LP-<date>-<8 hex>', /^LP-\d{8}-[0-9A-F]{8}$/.test(C.leadUidFrom('intake:website:abc', 1786370400)), true);

console.log('\n--- assignment rungs ------------------------------------------');
const agents = [
  { agent_id: 'a1', services: 'automation,rag', capacity: 10, open_leads: 8, available: true },
  { agent_id: 'a2', services: 'automation', capacity: 10, open_leads: 2, available: true },
  { agent_id: 'a3', services: 'consulting', capacity: 10, open_leads: 0, available: true },
  { agent_id: 'a4', services: 'automation', capacity: 10, open_leads: 0, available: false },
];
check('least loaded matching agent wins', C.pickOwner(agents, 'automation', 'mgr').agent_id, 'a2');
check('  ...on rung 1', C.pickOwner(agents, 'automation', 'mgr').rung, 1);
check('unmatched category falls to rung 2', C.pickOwner(agents, 'custom_app', 'mgr').rung, 2);
check('unavailable agents are never picked', C.pickOwner(
  [{ agent_id: 'a4', services: 'automation', capacity: 10, open_leads: 0, available: false }],
  'automation', 'mgr').agent_id, 'mgr');
check('  ...and that raises an alert', C.pickOwner([], 'automation', 'mgr').alert, true);
check('a full team falls through to the fallback owner', C.pickOwner(
  [{ agent_id: 'a1', services: 'automation', capacity: 5, open_leads: 5, available: true }],
  'automation', 'mgr').rung, 3);
check('ties break deterministically by agent_id', C.pickOwner([
  { agent_id: 'z1', services: 'automation', capacity: 10, open_leads: 1, available: true },
  { agent_id: 'b1', services: 'automation', capacity: 10, open_leads: 1, available: true },
], 'automation', 'mgr').agent_id, 'b1');

console.log('\n--- retry policy ----------------------------------------------');
// Jitter makes a single sample a coin toss, so hammer it. The original
// implementation clamped before jittering and returned up to 10s from an
// "8s cap"; one sample passed, 2000 did not.
let capViolations = 0;
let floorViolations = 0;
for (let i = 0; i < 2000; i++) {
  const ms = C.backoffMs((i % 9) + 1);
  if (ms > C.RETRY.CAP_MS) capViolations++;
  if (ms < C.RETRY.BASE_MS) floorViolations++;
}
check('backoff never exceeds the 8s cap over 2000 samples', capViolations, 0);
check('backoff never drops below the base delay', floorViolations, 0);
check('backoff grows with the attempt number', C.backoffMs(1) < C.RETRY.CAP_MS, true);
check('429 is retryable', C.RETRY.RETRYABLE_STATUS.includes(429), true);
check('400 is permanent', C.RETRY.RETRYABLE_STATUS.includes(400), false);
check('401 is permanent (a dead credential must not be retried 3x)', C.RETRY.RETRYABLE_STATUS.includes(401), false);

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
