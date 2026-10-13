import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy the actual cleaner into isolated projects; never run it against this project.
const script = readFileSync(fileURLToPath(new URL('../scripts/clean.mjs', import.meta.url)), 'utf8');
const temp = realpathSync(tmpdir());
const scratch = mkdtempSync(path.join(temp, 'bookshelf-clean-test-'));
const marker = 'fake-api-key-must-never-appear-in-diagnostics';
const generated = ['dist', '.cache/media', '.cache/qa', '.cache/tests'];
let sequence = 0;
function put(file, text = 'preserve this file') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function fixture() {
  const base = path.join(scratch, String(++sequence));
  const root = path.join(base, 'project');
  const appData = path.join(base, 'app-data');
  const customConfig = path.join(base, 'custom-config');
  put(path.join(root, 'scripts', 'clean.mjs'), script);
  for (const name of generated) put(path.join(root, name, 'generated.txt'));
  const persistent = ['.local/data/library.txt', '.local/config/keep.txt', 'release/app.exe', 'tools/tool.exe', '.env'];
  for (const name of persistent) put(path.join(root, name));
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { APPDATA: appData, SHELF_CONFIG_DIR: customConfig });
  return { root, appData, customConfig, env, persistent };
}
function run(item, ...args) {
  const result = spawnSync(process.execPath, [path.join(item.root, 'scripts', 'clean.mjs'), ...args], {
    cwd: item.root, env: item.env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  assert(!output.includes(marker), 'settings secrets must never appear in output');
  return { ...result, output };
}
function unchanged(item) {
  for (const name of [...generated.map(name => `${name}/generated.txt`), ...item.persistent]) {
    assert.equal(readFileSync(path.join(item.root, name), 'utf8'), 'preserve this file', name);
  }
}
function rejected(item, pattern = /protected library|persistent directory/) {
  for (const args of [[], ['--dry-run'], ['--apply']]) {
    const result = run(item, ...args);
    assert.notEqual(result.status, 0, 'unsafe cleanup must fail even in preview');
    assert.match(result.output, pattern);
  }
  unchanged(item);
}
function settings(file, dataDir) { put(file, JSON.stringify({ dataDir, providerKeys: { deepseek: marker } })); }
function junction(target, link) { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }

try {
  const ordinary = fixture();
  assert.equal(run(ordinary).status, 0);
  unchanged(ordinary);
  assert.equal(run(ordinary, '--dry-run').status, 0);
  unchanged(ordinary);
  const cleaned = run(ordinary, '--apply');
  assert.equal(cleaned.status, 0, cleaned.output);
  for (const name of generated) assert(!existsSync(path.join(ordinary.root, name)));
  for (const name of ordinary.persistent) assert.equal(readFileSync(path.join(ordinary.root, name), 'utf8'), 'preserve this file');
  console.log('PASS preview preserves files; apply only removes the four generated directories');

  const local = fixture();
  settings(path.join(local.root, '.local/config/settings.json'), path.join(local.root, 'dist', 'future-library'));
  rejected(local); // Library does not exist yet; its ancestor still must be protected.

  const installed = fixture();
  settings(path.join(installed.appData, '研究书架', 'settings.json'), installed.root);
  rejected(installed); // Configured library is a parent of every generated directory.

  const explicit = fixture();
  settings(path.join(explicit.customConfig, 'settings.json'), path.join(explicit.root, '.cache/qa'));
  rejected(explicit); // Exact match must reject before dist is removed.

  const environment = fixture();
  environment.env.SHELF_DATA_DIR = path.join(environment.root, 'dist');
  rejected(environment);
  console.log('PASS local, installed, explicit and environment library locations block equal, ancestor and descendant cleanup');

  const alias = fixture();
  const aliasPath = path.join(path.dirname(alias.root), 'library-alias');
  junction(path.join(alias.root, 'dist'), aliasPath);
  settings(path.join(alias.customConfig, 'settings.json'), aliasPath);
  rejected(alias);
  console.log('PASS configured library junctions are compared by their real destination');

  const redirected = fixture();
  // Replace only this fixture's verified ordinary .cache directory.
  const cache = path.join(redirected.root, '.cache');
  assert.equal(realpathSync(cache), cache);
  assert.equal(path.dirname(cache), redirected.root);
  rmSync(cache, { recursive: true });
  for (const name of ['media', 'qa', 'tests']) put(path.join(redirected.root, '.local', name, 'generated.txt'));
  junction(path.join(redirected.root, '.local'), cache);
  rejected(redirected, /redirected cleanup path/);
  for (const name of ['media', 'qa', 'tests']) assert.equal(readFileSync(path.join(redirected.root, '.local', name, 'generated.txt'), 'utf8'), 'preserve this file');

  const nested = fixture();
  junction(path.join(nested.root, '.local'), path.join(nested.root, 'dist', 'persistent-link'));
  rejected(nested, /linked cleanup path/);
  console.log('PASS redirected parents and nested junctions fail before deleting any target');

  const invalid = fixture();
  put(path.join(invalid.customConfig, 'settings.json'), `{"dataDir": "dist", "apiKey": "${marker}"`);
  rejected(invalid, /Cannot safely read the library location/);
  console.log('PASS unreadable settings fail closed without exposing their content');
} finally {
  const canonical = realpathSync(scratch);
  assert.equal(path.dirname(canonical).toLowerCase(), temp.toLowerCase());
  assert(path.basename(canonical).startsWith('bookshelf-clean-test-'));
  rmSync(canonical, { recursive: true, force: true });
}
