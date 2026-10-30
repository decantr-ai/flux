import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const placementKey = ({ relativeFile, topic }) => `${relativeFile}:${topic}`;

async function tsxFiles(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

export async function loadHelpAuditInputs(root = repositoryRoot) {
  const manifest = JSON.parse(await readFile(resolve(root, 'ui/src/lib/help-placements.json'), 'utf8'));
  const registrySource = await readFile(resolve(root, 'ui/src/lib/help-topics.ts'), 'utf8');
  const registry = await transform(registrySource, { loader: 'ts', format: 'esm' });
  const { HELP_TOPICS: topics } = await import('data:text/javascript;base64,' + Buffer.from(registry.code).toString('base64'));
  const sources = new Map();
  for (const file of await tsxFiles(resolve(root, 'ui/src'))) sources.set(relative(root, file).replaceAll('\\', '/'), await readFile(file, 'utf8'));
  return { manifest, topics, sources };
}

// Deliberately a source coverage check: normalization drops comments and types,
// then a small scanner requires literal topic attributes. It does not prove
// semantic placement, nested-control safety, keyboard behavior, or accessibility.
export async function auditHelp(inputs) {
  const { manifest, topics, sources } = inputs ?? await loadHelpAuditInputs();
  const errors = [];
  const issue = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.requiredTopics) || !Array.isArray(manifest.placements)) {
    return { ok: false, errors: [{ code: 'invalid-manifest', message: 'Expected schemaVersion 1, requiredTopics and placements arrays.' }] };
  }
  const required = new Set(manifest.requiredTopics);
  if (required.size !== manifest.requiredTopics.length) issue('duplicate-required-topic', 'Each required topic must be declared once.');
  for (const topic of required) if (!Object.hasOwn(topics, topic)) issue('missing-registry-topic', `Required topic ${topic} is absent from the registry.`, { topic });
  for (const topic of Object.keys(topics)) {
    if (!required.has(topic)) issue('undeclared-registry-topic', `Registry topic ${topic} is not in the maintained required inventory.`, { topic });
    const value = topics[topic];
    if (!value.title?.trim() || !value.body?.trim() || !value.category?.trim()) issue('invalid-topic', `Topic ${topic} needs a title, body and category.`, { topic });
  }
  const expected = new Map(), surfaces = new Set();
  for (const placement of manifest.placements) {
    const { surface, relativeFile, topic, risk } = placement;
    if (!surface?.trim() || !risk?.trim() || !/^ui\/src\/.+\.tsx$/.test(relativeFile) || relativeFile.includes('..')) {
      issue('invalid-placement', 'Every placement needs a named surface, a ui/src TSX file, topic and risk.', { surface });
      continue;
    }
    if (surfaces.has(surface)) issue('duplicate-surface', `Surface ${surface} is declared more than once.`, { surface });
    surfaces.add(surface);
    if (!Object.hasOwn(topics, topic)) issue('unknown-declared-topic', `Surface ${surface} declares unknown topic ${topic}.`, { surface, topic });
    const key = placementKey(placement);
    expected.set(key, [...(expected.get(key) ?? []), placement]);
  }
  for (const topic of required) if (!manifest.placements.some(placement => placement.topic === topic)) issue('unplaced-required-topic', `Required topic ${topic} has no declared surface.`, { topic });

  const actual = new Map(), usedTopics = new Set();
  for (const [relativeFile, source] of sources) {
    const { code } = await transform(source, { loader: 'tsx', jsx: 'preserve', legalComments: 'none' });
    for (const match of code.matchAll(/<HelpHint\b([^>]*)>/g)) {
      const attribute = match[1].match(/\btopic\s*=\s*(["'])([^"']+)\1/);
      if (!attribute) { issue('nonliteral-topic', 'HelpHint requires a literal topic so coverage can be audited.', { relativeFile }); continue; }
      const topic = attribute[2], key = placementKey({ relativeFile, topic });
      usedTopics.add(topic);
      actual.set(key, (actual.get(key) ?? 0) + 1);
      if (!Object.hasOwn(topics, topic)) issue('unknown-topic', `Unknown help topic ${topic} in ${relativeFile}.`, { relativeFile, topic });
    }
  }
  for (const [key, placements] of expected) {
    const count = actual.get(key) ?? 0;
    if (count < placements.length) issue('missing-placement', `${key}: expected ${placements.length} placement(s), found ${count}.`, { surfaces: placements.map(placement => placement.surface) });
  }
  for (const [key, count] of actual) {
    const declared = expected.get(key)?.length ?? 0;
    if (count > declared) issue('unmatched-placement', `${key}: found ${count} placement(s), declared ${declared}. Update the maintained map.`, { key });
  }
  for (const topic of Object.keys(topics)) if (!usedTopics.has(topic)) issue('unused-topic', `Registered help topic ${topic} is unused.`, { topic });
  return { ok: errors.length === 0, topicCount: Object.keys(topics).length, declaredPlacementCount: manifest.placements.length, sourcePlacementCount: [...actual.values()].reduce((sum, count) => sum + count, 0), errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await auditHelp();
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Help source coverage: ${report.ok ? 'PASS' : 'FAIL'} (${report.topicCount} topics, ${report.sourcePlacementCount}/${report.declaredPlacementCount} declared placements).`);
      for (const error of report.errors) console.error(`[${error.code}] ${error.message}`);
      console.log('Checks the explicit maintained placement map; does not prove all confusion is covered, nested-control safety, or runtime accessibility.');
    }
    if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
