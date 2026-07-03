#!/usr/bin/env node
import { load } from 'js-yaml';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const configPath = resolve(projectRoot, 'config.yaml');
const tempPath = resolve(projectRoot, '.config.tmp.json');

if (!existsSync(configPath)) {
  console.error(`❌ ${configPath} not found`);
  process.exit(1);
}

let config;
try {
  const yaml = readFileSync(configPath, 'utf8');
  config = load(yaml);
} catch (e) {
  console.error(`❌ Failed to parse YAML: ${e.message}`);
  process.exit(1);
}

try {
  const json = JSON.stringify(config);
  writeFileSync(tempPath, json);

  const remote = process.argv.includes('--local') ? '' : '--remote';
  execSync(
    `npx wrangler kv key put --namespace-id=e47f4fc3903443f6bc8e359928ab5b5c "config" --path="${tempPath}" ${remote}`,
    { stdio: 'inherit', cwd: projectRoot },
  );
  console.log('✅ Config pushed to RSS_CONFIG KV');
} catch (e) {
  console.error(`❌ Failed to push config: ${e.message}`);
  process.exit(1);
} finally {
  if (existsSync(tempPath)) unlinkSync(tempPath);
}
