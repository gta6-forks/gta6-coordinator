import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('Worker code uses only Web APIs (no node: imports, no process/Buffer/require)', () => {
  for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /from ['"]node:/, file);
    assert.doesNotMatch(src, /\brequire\(/, file);
    assert.doesNotMatch(src, /\bprocess\.env\b/, file);
    assert.doesNotMatch(src, /\bBuffer\./, file);
  }
});

test('generated files are in sync with their sources', () => {
  execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--check'], { stdio: 'pipe' });
});

test('no secrets are committed in config; placeholders are explicit', () => {
  const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /REPLACE_WITH_OAUTH_KV_NAMESPACE_ID/);
  assert.doesNotMatch(wrangler, /GOOGLE_CLIENT_SECRET"\s*:/);
  assert.doesNotMatch(wrangler, /PRIVATE KEY/);
  const example = readFileSync(join(root, '.dev.vars.example'), 'utf8');
  for (const line of example.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) assert.match(line, /=$/, line);
});

test('landing page explains MCP connection, one-at-a-time and continuous mode, without third-party scripts', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /claude mcp add --transport http/);
  assert.match(html, /Uma tarefa por vez/);
  assert.match(html, /Modo contínuo/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.doesNotMatch(html, /style="/);
  const onboarding = readFileSync(join(root, 'public/onboarding.html'), 'utf8');
  assert.match(onboarding, /claim_next_task/);
});
