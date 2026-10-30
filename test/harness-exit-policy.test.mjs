import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResults, isEnvironmentBlocked } from '../scripts/harness/exit-policy.mjs';

test('mechanical exit classification counts manual work without treating it as passed', () => {
  assert.deepEqual(classifyResults([{status:'passed'},{status:'pending'}]), {counts:{passed:1,failed:0,'environment-blocked':0,pending:1},exitCode:0});
  assert.equal(classifyResults([{status:'environment-blocked'}]).exitCode,2);
  assert.equal(classifyResults([{status:'environment-blocked'},{status:'failed'}]).exitCode,1);
  assert.throws(()=>classifyResults([{status:'unknown'}]),/Unknown mechanical status/);
});
test('only recognized loopback listen restrictions are environmental blockers', () => {
  assert.equal(isEnvironmentBlocked({syscall:'listen',code:'EPERM'}),true);
  assert.equal(isEnvironmentBlocked({syscall:'read',code:'EPERM'}),false);
  assert.equal(isEnvironmentBlocked(new Error('assertion failed')),false);
});
