import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installSkill, uninstallSkill } from '../src/skill-install.mjs';

const runtimePath = resolve('bin/flux.mjs');
function project(t) { const dir = mkdtempSync(join(tmpdir(), 'flux-skill-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('project skill binds helper to its project, is repeatable and leaves records on removal', t => {
  const root = project(t), result = installSkill({ project: root, runtimePath });
  assert.equal(installSkill({ project: root, runtimePath }).alreadyInstalled, true);
  const helper = join(result.path, 'scripts', 'flux.mjs');
  const status = spawnSync(process.execPath, [helper, 'status'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout), []);
  const escape = spawnSync(process.execPath, [helper, 'status', '--project', tmpdir()], { encoding: 'utf8' });
  assert.equal(escape.status, 1); assert.match(escape.stderr, /bound to its installed project/);
  mkdirSync(join(root, '.flux')); writeFileSync(join(root, '.flux', 'preserved.txt'), 'history');
  assert.equal(uninstallSkill({ project: root }).removed, true);
  assert.equal(readFileSync(join(root, '.flux', 'preserved.txt'), 'utf8'), 'history');
  assert.equal(uninstallSkill({ project: root }).removed, false);
});
test('skill installation preserves conflicts and local modifications', t => {
  const root = project(t), result = installSkill({ project: root, runtimePath });
  writeFileSync(join(result.path, 'SKILL.md'), 'User changes');
  assert.throws(() => installSkill({ project: root, runtimePath }), /local changes/);
  assert.throws(() => uninstallSkill({ project: root }), /local changes/);
  assert.equal(readFileSync(join(result.path, 'SKILL.md'), 'utf8'), 'User changes');
});
test('skill installation refuses a symlinked destination outside the project', t => {
  const root = project(t), other = project(t); symlinkSync(other, join(root, '.agents'), 'dir');
  assert.throws(() => installSkill({ project: root, runtimePath }), /real directory/);
  assert.equal(existsSync(join(other, 'skills')), false);
});
