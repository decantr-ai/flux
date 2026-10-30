#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try {
  const binding = JSON.parse(readFileSync(new URL('../installation.json', import.meta.url), 'utf8'));
  if (binding.owner !== '@decantr/flux' || binding.version !== 1 || !binding.project || !binding.runtimePath) throw new Error('Invalid Flux installation binding');
  const args = process.argv.slice(2);
  if (args.some(arg => arg === '--project' || arg.startsWith('--project=') || arg === '--data-dir' || arg.startsWith('--data-dir=') || arg === '_serve')) throw new Error('This helper is bound to its installed project; use the main Flux command for another project');
  const result = spawnSync(process.execPath, [realpathSync(binding.runtimePath), ...args, '--project', realpathSync(binding.project)], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Flux skill: ${error.message}. Install or reinstall it with flux install-skill --project <project-directory>.`);
  process.exitCode = 1;
}
