/**
 * Error-classification unit tests. Run: node scripts/test-errors.js
 *
 * This suite exists because of a defect that reached production.
 *
 * LP-05 decides, for every failure in the system, whether it is `transient`
 * (wait and retry), `credential` (a human must log in somewhere) or
 * `permanent` (the input or the code is wrong; retrying is pointless). That
 * decision drives two things an operator acts on: whether an alert is sent,
 * and what the dead-letter row tells them to do about it.
 *
 * The rules lived inline in the Code node, which is the one place in this
 * project no test could reach. The transient pattern matched `timeout` and
 * `etimedout` but not `timed out` - and n8n's own task runner fails with
 * "Task request timed out after 60 seconds", two words. So the single most
 * retryable failure this instance produces fell through to the `permanent`
 * default: it alerted on something that should have retried quietly, and told
 * the operator not to retry the one thing that would have worked. It
 * misclassified two real production failures, on 2026-08-12 and 2026-08-15,
 * before anyone noticed.
 *
 * The rules now live in _shared/constants.js beside the scorer and the intake,
 * for exactly the reason those two are there: the code most likely to be
 * quietly wrong is the code that has to be testable outside n8n.
 */
const C = require('../02_Workflows/_shared/constants.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

const cls = (msg, name) => C.classifyError(msg, name).error_class;
const sev = (msg, name) => C.classifyError(msg, name).severity;

console.log('--- the regression this suite was written for -----------------');

// The exact string n8n emitted, twice, in LP-04's Claim Batch.
const RUNNER_TIMEOUT = 'Task request timed out after 60 seconds';
check('n8n task-runner timeout is transient', cls(RUNNER_TIMEOUT), 'transient');
check('  ...and warns rather than alerting as an error', sev(RUNNER_TIMEOUT), 'warning');

// The two-word form in its other spellings, so a reworded runtime message does
// not silently reopen the same hole.
check('"timed out" alone is transient', cls('the request timed out'), 'transient');
check('"timed  out" with extra spacing is transient', cls('Task timed  out'), 'transient');
check('"timedout" one word is transient', cls('socket timedout'), 'transient');
check('"Timed Out" capitalised is transient', cls('Request Timed Out'), 'transient');

console.log('\n--- transient ------------------------------------------------');
check('ECONNREFUSED', cls('connect ECONNREFUSED 10.0.0.1:443'), 'transient');
check('ETIMEDOUT', cls('connect ETIMEDOUT'), 'transient');
check('ENOTFOUND', cls('getaddrinfo ENOTFOUND odoo.example.com'), 'transient');
check('socket hang up', cls('socket hang up'), 'transient');
check('429 rate limit', cls('Request failed with status code 429'), 'transient');
check('502 bad gateway', cls('Request failed with status code 502'), 'transient');
check('503 unavailable', cls('Service temporarily unavailable'), 'transient');
check('504 gateway timeout', cls('Request failed with status code 504'), 'transient');
check('serialization failure', cls('could not serialize access due to concurrent update'), 'transient');

console.log('\n--- credential (escalated on sight) --------------------------');
check('401', cls('Request failed with status code 401'), 'credential');
check('403', cls('Request failed with status code 403'), 'credential');
check('unauthorized', cls('Unauthorized'), 'credential');
check('unauthorised (en-GB)', cls('Unauthorised'), 'credential');
check('invalid api key', cls('invalid api key supplied'), 'credential');
check('token expired', cls('The access token expired'), 'credential');
check('refresh token', cls('refresh token is invalid or revoked'), 'credential');
check('authentication failed', cls('Odoo authentication failed'), 'credential');
check('credential errors are critical', sev('Unauthorized'), 'critical');

// A dead credential often surfaces alongside a timeout. It must not be
// downgraded to transient and retried three times against a dead token - that
// is how a frozen pipeline stays quiet for 25 days.
check('401 wins over a co-occurring timeout', cls('401 Unauthorized after the request timed out'), 'credential');

console.log('\n--- permanent ------------------------------------------------');
check('unknown column', cls("Validation error with data table request: unknown column name 'urgency'"), 'permanent');
check('invalid Odoo field', cls("Invalid field crm.lead.mobile in condition"), 'permanent');
check('bad JSON', cls('Unexpected token < in JSON at position 0'), 'permanent');
check('400', cls('Request failed with status code 400'), 'permanent');
check('a plain code bug', cls("Cannot read properties of undefined (reading 'lead_uid')"), 'permanent');
check('permanent errors report as error severity', sev('Request failed with status code 400'), 'error');

console.log('\n--- defensive ------------------------------------------------');
// The handler must never throw while handling an error.
check('empty message does not throw', cls(''), 'permanent');
check('null message does not throw', cls(null), 'permanent');
check('undefined message does not throw', cls(undefined), 'permanent');
check('the error NAME is searched too', cls('', 'ETIMEDOUT'), 'transient');
check('name and message combine', cls('failed', 'FetchError: 503'), 'transient');

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
