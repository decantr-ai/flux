import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, shell: false, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} exited ${result.status}`);
  return result.stdout;
};
run('npm', ['run', 'build'], { stdio: 'inherit' });
run(process.execPath, ['scripts/package-notices.mjs'], { stdio: 'inherit' });
mkdirSync(output, { recursive: true });
const [pack] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output, '--cache', join(output, '.npm-cache')]));
const required = ['bin/flux.mjs', 'src/skill-install.mjs', 'src/workspaces.mjs', 'src/lifecycle.mjs', 'public/build/index.html', 'integrations/codex/skills/flux/SKILL.md', 'integrations/codex/skills/flux/scripts/flux.mjs', 'public/fonts/Geist-OFL.txt', 'public/fonts/Geist-Mono-OFL.txt', 'docs/INSTALL.md', 'NOTICE'];
const inventory = pack.files.map(file => file.path);
for (const file of required) if (!inventory.includes(file)) throw new Error(`Package is missing ${file}`);
for (const file of inventory) {
  if (!/^(?:package\.json|README\.md|NOTICE|THIRD_PARTY_NOTICES\.txt|bin\/|src\/|integrations\/codex\/|public\/(?:build|fonts|images)\/|docs\/(?:(?:INSTALL|PACKAGE)\.md|images\/))/.test(file) || /(?:^|\/)(?:\.flux|node_modules|test|tests|connection\.json|installation\.json)(?:\/|$)/.test(file) || /(?:bootstrap\.mjs|cli\.mjs|evaluations\/)/.test(file)) throw new Error(`Unexpected package member: ${file}`);
  if (/\.(?:mjs|js|json|md|html|css|yaml)$/.test(file)) {
    const text = readFileSync(join(root, file), 'utf8');
    if (/(?:\/Users\/|\/private\/tmp\/|\/var\/folders\/)/.test(text)) throw new Error(`Host-specific data in package: ${file}`);
  }
}
const archive = join(output, pack.filename);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const manifest = { name: pack.name, version: pack.version, filename: pack.filename, sha256, bytes: pack.size, unpackedBytes: pack.unpackedSize, files: pack.files, publicPublication: false };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${pack.filename}\n`);
console.log(JSON.stringify({ archive, sha256, files: inventory.length, bytes: pack.size, publicPublication: false }, null, 2));
