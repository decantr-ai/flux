import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const template = fileURLToPath(new URL('../integrations/codex/skills/flux/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function filesIn(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Flux skill files cannot be symlinks');
    return entry.isDirectory() ? filesIn(file, root) : entry.isFile() ? [relative(root, file)] : (() => { throw new Error('Unsupported skill file'); })();
  }).sort();
}
function targetFor(project, create) {
  const root = realpathSync(resolve(project));
  for (const part of ['.agents', '.agents/skills']) {
    const directory = join(root, part);
    if (existsSync(directory) || (() => { try { lstatSync(directory); return true; } catch { return false; } })()) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The project skill directory must be a real directory inside the project');
    } else if (create) mkdirSync(directory, { mode: 0o700 });
  }
  const target = join(root, '.agents', 'skills', 'flux');
  try { if (lstatSync(target).isSymbolicLink()) throw new Error('An existing Flux skill symlink will not be replaced'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { root, target };
}
function installed(target) {
  try {
    const manifest = JSON.parse(readFileSync(join(target, 'installation.json'), 'utf8'));
    if (manifest.owner !== '@decantr/flux' || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new Error('Not a Flux-managed skill');
    const actual = filesIn(target).filter(file => file !== 'installation.json');
    const expected = Object.keys(manifest.files).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || actual.some(file => digest(readFileSync(join(target, file))) !== manifest.files[file])) throw new Error('The installed skill has local changes; preserve or move it before replacing/removing it');
    return manifest;
  } catch (error) { throw new Error(`Existing skill will be preserved: ${error.message}`); }
}
export function installSkill({ project, runtimePath }) {
  const runtime = realpathSync(resolve(runtimePath));
  const { root, target } = targetFor(project, true);
  if (existsSync(target)) {
    const previous = installed(target);
    if (previous.project !== root || previous.runtimePath !== runtime) throw new Error('A different Flux skill is already installed; explicitly uninstall it before changing its binding');
    return { installed: true, alreadyInstalled: true, path: target, project: root };
  }
  const staging = join(dirname(target), `.flux-install-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const checksums = {};
    for (const file of filesIn(template)) {
      const bytes = readFileSync(join(template, file));
      mkdirSync(dirname(join(staging, file)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, file), bytes, { mode: 0o600 });
      checksums[file] = digest(bytes);
    }
    writeFileSync(join(staging, '.gitignore'), 'installation.json\n', { mode: 0o600 });
    checksums['.gitignore'] = digest('installation.json\n');
    writeFileSync(join(staging, 'installation.json'), JSON.stringify({ owner: '@decantr/flux', version: 1, project: root, runtimePath: runtime, files: checksums }, null, 2), { mode: 0o600 });
    renameSync(staging, target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return { installed: true, path: target, project: root, next: 'Use $flux in this project. Connecting a chat remains an explicit action.' };
}
export function uninstallSkill({ project }) {
  const { root, target } = targetFor(project, false);
  if (!existsSync(target)) return { removed: false, path: target };
  const manifest = installed(target);
  if (manifest.project !== root) throw new Error('Installed skill belongs to a different project');
  rmSync(target, { recursive: true });
  return { removed: true, path: target, recordsRetained: true };
}
