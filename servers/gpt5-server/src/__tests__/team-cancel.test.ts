import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBridgeCancelUrl, buildCancelCommand, mapCancelBridgeError, validateCancelJobId,
} from '../team.js';

// --- validateCancelJobId: reject anything that is not a plain job id before it
// ever reaches a command line ---

test('validateCancelJobId accepts a well-formed bridge job id', () => {
  assert.doesNotThrow(() => validateCancelJobId('tb_abc123_def45678'));
});

test('validateCancelJobId accepts the minimum length (8 chars)', () => {
  assert.doesNotThrow(() => validateCancelJobId('abcdefgh'));
});

test('validateCancelJobId accepts the maximum length (128 chars)', () => {
  assert.doesNotThrow(() => validateCancelJobId('a'.repeat(128)));
});

test('validateCancelJobId rejects a too-short id', () => {
  assert.throws(() => validateCancelJobId('short'), /invalid job_id/);
});

test('validateCancelJobId rejects an id over 128 chars', () => {
  assert.throws(() => validateCancelJobId('a'.repeat(129)), /invalid job_id/);
});

test('validateCancelJobId rejects path traversal / injection characters', () => {
  assert.throws(() => validateCancelJobId('../../etc/passwd'), /invalid job_id/);
  assert.throws(() => validateCancelJobId('tb_abc; rm -rf /'), /invalid job_id/);
  assert.throws(() => validateCancelJobId('tb_abc$(whoami)'), /invalid job_id/);
  assert.throws(() => validateCancelJobId('tb_abc\ndef12345'), /invalid job_id/);
  assert.throws(() => validateCancelJobId('tb abc def 1234'), /invalid job_id/);
});

// --- buildBridgeCancelUrl: reason must be percent-encoded, never raw ---

test('buildBridgeCancelUrl with no reason omits the query string', () => {
  const url = buildBridgeCancelUrl(8721, 'tb_abc12345');
  assert.equal(url, 'http://127.0.0.1:8721/dispatch/tb_abc12345/cancel');
});

test('buildBridgeCancelUrl percent-encodes a hostile reason', () => {
  const reason = `re-route to Bob'; $(whoami) \`id\` "quoted"\nnewline`;
  const url = buildBridgeCancelUrl(8721, 'tb_abc12345', reason);
  assert.ok(url.startsWith('http://127.0.0.1:8721/dispatch/tb_abc12345/cancel?reason='));
  const encoded = url.split('reason=')[1];
  // The dangerous raw substrings must never appear unencoded in the URL.
  assert.ok(!encoded.includes('`'));
  assert.ok(!encoded.includes('"'));
  assert.ok(!encoded.includes('\n'));
  assert.ok(!encoded.includes('$('));
  // Decoding it back must reproduce the exact original reason.
  assert.equal(decodeURIComponent(encoded), reason);
});

// --- buildCancelCommand: hostile input must land as inert data, never shell syntax ---

test('buildCancelCommand wraps a single python3 -c invocation and embeds the url/token safely', () => {
  // No apostrophe here on purpose — the quote-escaping path is covered by the
  // dedicated test below; this one checks the other hostile shell metacharacters.
  const reason = 'boom; rm -rf ~ #';
  const url = buildBridgeCancelUrl(8721, 'tb_abc12345', reason);
  const command = buildCancelCommand(url, '/home/ops/.gpt5mcp/bridge-token');
  assert.ok(command.startsWith("python3 -c '"));
  assert.ok(command.endsWith("'"));
  // The hostile reason is only ever present in percent-encoded form.
  assert.ok(!command.includes(reason));
  assert.ok(command.includes(encodeURIComponent(reason)));
  // The url and token path are embedded as JSON/Python string literals.
  assert.ok(command.includes(JSON.stringify(url)));
  assert.ok(command.includes(JSON.stringify('/home/ops/.gpt5mcp/bridge-token')));
  // Bridge auth header is present, as in the existing dispatch call.
  assert.ok(command.includes('X-Dispatch-Token'));
});

test('buildCancelCommand safely escapes a single quote inside the token path', () => {
  const url = buildBridgeCancelUrl(8721, 'tb_abc12345');
  const command = buildCancelCommand(url, "/home/o'ps/.gpt5mcp/bridge-token");
  // shellQuote must have escaped the embedded single quote using the standard
  // '\'' pattern so the outer python3 -c '...' argument is never broken out of.
  assert.ok(command.includes(`'\\''`));
});

test('buildCancelCommand neutralizes newlines, $(...) and backticks from a hostile reason', () => {
  const hostileReason = 'a\nb$(touch /tmp/pwned)`touch /tmp/pwned2`';
  const url = buildBridgeCancelUrl(9000, 'tb_hostile01', hostileReason);
  const command = buildCancelCommand(url, '/home/ops/.gpt5mcp/bridge-token');
  assert.ok(!command.includes('$(touch'));
  assert.ok(!command.includes('`touch'));
  assert.ok(command.includes(encodeURIComponent(hostileReason)));
});

// --- mapCancelBridgeError: clear, specific messages per status code ---

test('mapCancelBridgeError maps 409 to a running/finished explanation', () => {
  const message = mapCancelBridgeError(409, 'tb_abc12345', '');
  assert.match(message, /tb_abc12345/);
  assert.match(message, /running or already finished/);
  assert.match(message, /only queued jobs can be cancelled/);
});

test('mapCancelBridgeError maps 404 to an unknown-job explanation', () => {
  const message = mapCancelBridgeError(404, 'tb_missing01', '');
  assert.match(message, /unknown job tb_missing01/);
});

test('mapCancelBridgeError maps 401 to an unauthorized explanation', () => {
  const message = mapCancelBridgeError(401, 'tb_abc12345', '');
  assert.match(message, /rejected the dispatch token/);
  assert.match(message, /401/);
});

test('mapCancelBridgeError includes truncated bridge body detail when present', () => {
  const message = mapCancelBridgeError(409, 'tb_abc12345', '{"error":"already running"}');
  assert.match(message, /already running/);
});

test('mapCancelBridgeError falls back to a generic message for other status codes', () => {
  const message = mapCancelBridgeError(500, 'tb_abc12345', 'boom');
  assert.match(message, /status 500/);
});
