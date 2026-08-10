/**
 * Deterministic lead scoring. This is the exact body inlined into the
 * `Score Lead` Code node in LP-02, kept here so it can be unit-tested outside
 * n8n (see scripts/test-scoring.mjs).
 *
 * Two rules govern everything below:
 *   1. The AI contributes zero points. Delete the AI layer and this still runs.
 *   2. Every factor emits a breakdown line. A score you cannot explain line by
 *      line is a score you cannot defend when a salesperson disputes it.
 */

const C = require('./constants.js');

function bucketSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n >= 201) return '201+';
  if (n >= 51) return '51-200';
  if (n >= 11) return '11-50';
  return '1-10';
}

function bucketIndustry(industry) {
  const s = String(industry || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (C.EXCLUDED_INDUSTRIES.some((x) => s.includes(x))) return 'excluded';
  if (C.TARGET_INDUSTRIES.some((x) => s.includes(x))) return 'target';
  if (C.ADJACENT_INDUSTRIES.some((x) => s.includes(x))) return 'adjacent';
  return 'unknown';
}

function bucketMarket(country) {
  const c = String(country || '').toUpperCase();
  if (!c) return 'unknown';
  if (C.CORE_MARKETS.includes(c)) return 'core';
  if (C.ADJACENT_MARKETS.includes(c)) return 'adjacent';
  return 'other';
}

function bucketService(service) {
  const s = String(service || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return 'unknown';
  if (C.HIGH_VALUE_SERVICES.includes(s)) return 'high';
  if (C.MID_VALUE_SERVICES.includes(s)) return 'mid';
  return 'low';
}

/**
 * Accepts a band that intake already derived ('high' | 'mid' | 'unknown'), or a
 * raw amount for any caller that did not come through intake. Thresholds live
 * in constants.js, so the two paths cannot drift apart.
 */
function bucketBudget(budget) {
  const s = String(budget || '').trim().toLowerCase();
  if (s === 'high' || s === 'mid' || s === 'unknown' || s === '') {
    return s || 'unknown';
  }
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n >= C.BUDGET_USD.HIGH) return 'high';
  if (n >= C.BUDGET_USD.MID) return 'mid';
  return 'unknown';
}

/**
 * @param {object} lead      canonical lead
 * @param {object} enrich    {company_size, industry, country, strategic} or {} when unavailable
 * @returns {{score, band, strategic, disqualified, breakdown}}
 */
function scoreLead(lead, enrich = {}) {
  const breakdown = [];
  let total = 0;
  const add = (factor, value, points, note) => {
    total += points;
    breakdown.push({ factor, value, points, note: note || '' });
  };

  // Enrichment fills gaps; it never overrides something the lead stated.
  const country = lead.country || enrich.country || '';
  const industryBucket = bucketIndustry(enrich.industry);

  // Hard disqualifier: an out-of-scope vertical is worth zero regardless of
  // every other signal, so it short-circuits before any points are awarded.
  if (industryBucket === 'excluded') {
    return {
      score: 0,
      band: 'unqualified',
      strategic: false,
      disqualified: true,
      disqualify_reason: `excluded industry: ${enrich.industry}`,
      breakdown: [{ factor: 'industry', value: enrich.industry, points: 0, note: 'excluded vertical, hard disqualify' }],
    };
  }

  const freeText = `${lead.free_text || ''} ${lead.service_interest || ''}`;
  if (C.DISQUALIFY_PATTERNS.test(freeText)) {
    add('intent_penalty', 'job/competitor/solicitation language',
      C.SCORE.penalty.competitor_or_jobseeker, 'matched the disqualify pattern');
  }

  const sizeB = bucketSize(enrich.company_size);
  add('company_size', sizeB, C.SCORE.company_size[sizeB],
    sizeB === 'unknown' ? 'not enriched, scored at the unknown band rather than zero' : '');

  add('industry', industryBucket, C.SCORE.industry[industryBucket],
    industryBucket === 'unknown' ? 'not enriched, scored at the unknown band rather than zero' : '');

  const marketB = bucketMarket(country);
  add('market', marketB, C.SCORE.market[marketB],
    lead.country ? '' : (country ? 'derived from the E.164 prefix' : 'no country signal'));

  const serviceB = bucketService(lead.service_interest);
  add('service', serviceB, C.SCORE.service[serviceB]);

  // Field names are the CANONICAL ones from _shared/intake.js. They were once
  // `stated_urgency` and `stated_budget` here and `urgency` and `budget_band`
  // there, which meant every real lead scored as though it had stated neither -
  // silently, because a missing field is a legal "unknown". Only a test that
  // ran intake and the scorer together caught it, which is why that test exists.
  const urgency = String(lead.urgency || 'unknown');
  add('urgency', urgency, C.SCORE.urgency[urgency] ?? C.SCORE.urgency.unknown);

  const hasEmail = !!lead.email_norm && C.EMAIL_RE.test(lead.email_norm);
  const hasPhone = !!lead.phone_key && lead.phone_key.length >= 10;
  const completeness = hasEmail && hasPhone ? 'both' : 'one';
  add('completeness', completeness, C.SCORE.completeness[completeness]);

  const src = String(lead.source || '').toLowerCase();
  add('source', src, C.SCORE.source[src] ?? 0);

  const budgetB = bucketBudget(lead.budget_band);
  add('budget', budgetB, C.SCORE.budget[budgetB]);

  const emailDomain = String(lead.email_norm || '').split('@')[1] || '';
  if (C.DISPOSABLE_EMAIL_DOMAINS.has(emailDomain)) {
    add('disposable_email', emailDomain, C.SCORE.penalty.disposable_email, 'throwaway inbox');
  }

  const raw = total;
  const score = Math.max(0, Math.min(C.SCORE.MAX, raw));
  if (raw !== score) breakdown.push({ factor: 'clamp', value: `${raw} -> ${score}`, points: 0, note: 'clamped to 0..100' });

  const strategic = String(enrich.strategic) === 'true' || enrich.strategic === true;
  if (strategic) breakdown.push({ factor: 'strategic_account', value: true, points: 0, note: 'forces the VIP band regardless of score' });

  return { score, band: C.bandFor(score, strategic), strategic, disqualified: false, breakdown };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreLead, bucketSize, bucketIndustry, bucketMarket, bucketService, bucketBudget };
}
