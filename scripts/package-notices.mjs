import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packages = ['react','react-dom','@base-ui/react','tailwindcss','lucide-react','react-markdown','remark-gfm','unified','remark-parse','mdast-util-to-string','clsx','class-variance-authority','tailwind-merge'];
const visited = new Set(), notices = [];
function visit(name, parent = root) {
  const local = join(parent, 'node_modules', name), directory = existsSync(join(local, 'package.json')) ? local : join(root, 'node_modules', name);
  if (visited.has(directory)) return; visited.add(directory);
  const info = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const licenses = readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file));
  if (!licenses.length) throw new Error(`Missing third-party license for ${info.name}`);
  notices.push(`===== ${info.name}@${info.version} =====\n\n${licenses.map(file => readFileSync(join(directory, file), 'utf8')).join('\n\n')}`);
  for (const dependency of Object.keys(info.dependencies ?? {})) visit(dependency, directory);
}
packages.forEach(name => visit(name));
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), 'Third-party notices for the Flux runtime and bundled interface.\n\n' + notices.join('\n\n'));
console.log(`Retained ${notices.length} dependency license notices.`);
