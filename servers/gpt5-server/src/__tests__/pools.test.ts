import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Target } from '../targets.js';
import {
  annotateEmployeeWithPool, buildDirectory, buildPoolsSummary, evaluatePoolGate,
  memberPoolStatus, readPoolsFile, type PoolsFile,
} from '../pools.js';

const LOCAL_TARGET: Target = { name: 'local', type: 'local' };

function pools(overrides: Partial<PoolsFile> = {}): PoolsFile {
  return {
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'ops',
    pools: {
      p1: { provider: 'anthropic', plan: 'team', status: 'green', note: 'fine', dashboard: 'https://x' },
      p2: { provider: 'openai', plan: 'team', status: 'red', note: 'over budget', dashboard: 'https://y' },
      p3: { provider: 'openai', plan: 'solo', status: 'yellow', note: 'near limit' },
    },
    members: {
      alice: { host: 'mini', runtime: 'codex', model: 'gpt-5.6-sol', pool: 'p1', bestFor: 'backend', fallback: ['bob'] },
      bob: { host: 'mini', runtime: 'codex', model: 'gpt-5.6-sol', pool: 'p2', bestFor: 'infra', fallback: ['alice'] },
      carol: { host: 'mini', runtime: 'codex', model: 'gpt-5.6-sol', pool: 'p3', bestFor: 'frontend', fallback: [] },
      // no pool assigned
      dave: { host: 'mini', runtime: 'codex', model: 'gpt-5.6-sol', fallback: [] },
    },
    ...overrides,
  };
}

// --- readPoolsFile: no file / malformed file must never throw and must degrade to null ---

test('readPoolsFile returns null when pools.json does not exist (unchanged behavior)', () => {
  const result = readPoolsFile(LOCAL_TARGET, '/fake/team/root', {
    pathExists: () => false,
    readFile: () => { throw new Error('should not be called when path does not exist'); },
  });
  assert.equal(result, null);
});

test('readPoolsFile ignores a malformed file (invalid JSON) instead of throwing', () => {
  assert.doesNotThrow(() => {
    const result = readPoolsFile(LOCAL_TARGET, '/fake/team/root', {
      pathExists: () => true,
      readFile: () => '{ not valid json',
    });
    assert.equal(result, null);
  });
});

test('readPoolsFile ignores a malformed file (wrong shape) instead of throwing', () => {
  const result = readPoolsFile(LOCAL_TARGET, '/fake/team/root', {
    pathExists: () => true,
    readFile: () => JSON.stringify({ schemaVersion: 1, pools: 'not-an-object' }),
  });
  assert.equal(result, null);
});

test('readPoolsFile parses a well-formed file and normalizes an unknown status', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    pools: { p1: { status: 'purple', provider: 'x' } },
    members: { eve: { pool: 'p1', fallback: ['alice', 42] } },
  });
  const result = readPoolsFile(LOCAL_TARGET, '/fake/team/root', {
    pathExists: () => true,
    readFile: () => raw,
  });
  assert.ok(result);
  assert.equal(result!.pools.p1.status, 'unknown');
  assert.deepEqual(result!.members.eve.fallback, ['alice']);
});

// --- dispatch gate: red refuses, red+force dispatches, yellow warns, green/unknown/no-file unchanged ---

test('evaluatePoolGate blocks dispatch when the pool is red', () => {
  const gate = evaluatePoolGate(pools(), 'Bob', 'bob', false);
  assert.match(gate.blocked!, /Bob's credit pool p2 is RED \(over budget\)/);
  assert.match(gate.blocked!, /Use fallback: alice/);
  assert.match(gate.blocked!, /Pass force=true to override/);
  assert.equal(gate.warning, undefined);
});

test('evaluatePoolGate allows dispatch when red and force=true', () => {
  const gate = evaluatePoolGate(pools(), 'Bob', 'bob', true);
  assert.equal(gate.blocked, undefined);
});

test('evaluatePoolGate warns but does not block when the pool is yellow', () => {
  const gate = evaluatePoolGate(pools(), 'Carol', 'carol', false);
  assert.equal(gate.blocked, undefined);
  assert.match(gate.warning!, /Carol's credit pool p3 is YELLOW \(near limit\)/);
});

test('evaluatePoolGate is a no-op for green pools', () => {
  const gate = evaluatePoolGate(pools(), 'Alice', 'alice', false);
  assert.deepEqual(gate, {});
});

test('evaluatePoolGate is a no-op for a member with no assigned pool', () => {
  const gate = evaluatePoolGate(pools(), 'Dave', 'dave', false);
  assert.deepEqual(gate, {});
});

test('evaluatePoolGate is a no-op for an unlisted member', () => {
  const gate = evaluatePoolGate(pools(), 'Ghost', 'ghost', false);
  assert.deepEqual(gate, {});
});

test('evaluatePoolGate is a no-op when there is no pools file at all', () => {
  const gate = evaluatePoolGate(null, 'Bob', 'bob', false);
  assert.deepEqual(gate, {});
});

// --- team_manifest / team_list annotation ---

test('buildPoolsSummary reports health counts and passes through updatedAt', () => {
  const summary = buildPoolsSummary(pools());
  assert.deepEqual(summary.health, { green: 1, yellow: 1, red: 1, unknown: 0 });
  assert.equal(summary.updatedAt, '2026-01-01T00:00:00Z');
  assert.equal(summary.pools.p2.status, 'red');
});

test('buildPoolsSummary degrades to empty/zeroed output with no pools file', () => {
  const summary = buildPoolsSummary(null);
  assert.deepEqual(summary.pools, {});
  assert.deepEqual(summary.health, { green: 0, yellow: 0, red: 0, unknown: 0 });
  assert.equal(summary.updatedAt, undefined);
});

test('buildDirectory merges each member with its pool status and fallback', () => {
  const directory = buildDirectory(pools());
  assert.equal(directory.bob.poolStatus, 'red');
  assert.equal(directory.bob.poolNote, 'over budget');
  assert.deepEqual(directory.bob.fallback, ['alice']);
  assert.equal(directory.alice.poolStatus, 'green');
  assert.equal(directory.dave.pool, undefined);
});

test('annotateEmployeeWithPool adds pool fields for a known member and keeps existing fields', () => {
  const employee = { slug: 'bob', name: 'Bob', workspace: '/dev/x' };
  const annotated = annotateEmployeeWithPool(employee, pools());
  assert.equal(annotated.name, 'Bob');
  assert.equal(annotated.workspace, '/dev/x');
  assert.equal(annotated.pool, 'p2');
  assert.equal(annotated.poolStatus, 'red');
  assert.deepEqual(annotated.fallback, ['alice']);
});

test('annotateEmployeeWithPool leaves an unknown employee unchanged when there is no pools file', () => {
  const employee = { slug: 'zed', name: 'Zed' };
  const annotated = annotateEmployeeWithPool(employee, null);
  assert.deepEqual(annotated, employee);
});

test('annotateEmployeeWithPool leaves an employee not present in pools.json unchanged', () => {
  const employee = { slug: 'ghost', name: 'Ghost' };
  const annotated = annotateEmployeeWithPool(employee, pools());
  assert.deepEqual(annotated, employee);
});

test('memberPoolStatus treats an unassigned pool id as unknown', () => {
  const withDanglingPool = pools({
    members: { erin: { host: 'mini', runtime: 'codex', model: 'x', pool: 'does-not-exist', fallback: [] } },
  });
  const status = memberPoolStatus(withDanglingPool, 'erin');
  assert.equal(status.status, 'unknown');
});
