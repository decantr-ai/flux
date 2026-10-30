import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageFile = path.join(root, 'node_modules/lucide/package.json');
const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
if (version !== '1.57.0') throw new Error(`Expected Lucide 1.57.0; found ${version}`);

const output = path.join(root, 'public/vendor');
fs.mkdirSync(output, { recursive: true });
await build({
  entryPoints: [path.join(root, 'scripts/lucide-tabs.mjs')],
  outfile: path.join(output, 'flux-icons.min.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2018',
  legalComments: 'none',
});
fs.copyFileSync(packageFile.replace(/package\.json$/, 'LICENSE'), path.join(output, 'lucide-LICENSE.txt'));
