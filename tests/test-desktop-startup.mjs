// Exercise the built Electron entry, preload, renderer and utility service.
// Uses a fresh hidden desktop app and a whitelist environment; no live library
// or provider configuration is copied, and no research/model request is made.
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';
import { projectRoot, qaRoot } from './workspace.mjs';

const fixture = await mkdtemp(path.join(qaRoot, 'desktop-startup-'));
let child;
let timeout;
try {
  await cp(path.join(projectRoot, 'dist'), path.join(fixture, 'dist'), { recursive: true });
  for (const name of ['user-data', 'app-data', 'temp', 'home']) await mkdir(path.join(fixture, name));
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'research-bookshelf-startup-test', version: '0.0.0', main: 'bootstrap.cjs' }));
  await writeFile(path.join(fixture, 'bootstrap.cjs'), String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { app, dialog, session } = require('electron');
const fixture = __dirname;
const resultFile = path.join(fixture, 'result.json');
let finished = false;
let windows = 0;
let visible = false;
let networkRequests = 0;
app.setName('research-bookshelf-startup-test');
app.setPath('userData', path.join(fixture, 'user-data'));
app.setPath('appData', path.join(fixture, 'app-data'));
app.setPath('temp', path.join(fixture, 'temp'));
app.disableHardwareAcceleration();
function finish(result) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(resultFile, JSON.stringify({ ...result, windows, visible, networkRequests }));
  process.exitCode = result.ok ? 0 : 1;
  app.quit();
  setTimeout(() => app.exit(result.ok ? 0 : 1), 8000).unref();
}
const fail = error => finish({ ok: false, error: String(error?.stack || error) });
dialog.showErrorBox = (title, message) => fail(new Error(title + ': ' + message));
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    networkRequests++;
    callback({ cancel: true });
  });
}).catch(fail);
app.on('browser-window-created', (_event, window) => {
  windows++;
  // The application deliberately starts with show:false. Keep its ready-to-show
  // callback hidden while retaining the real BrowserWindow and WebContents.
  window.show = () => {};
  window.showInactive = () => {};
  window.on('show', () => { visible = true; window.hide(); });
  window.webContents.on('did-fail-load', (_event, code, description) => fail(new Error('Renderer load failed: ' + code + ' ' + description)));
  window.webContents.on('preload-error', (_event, _file, error) => fail(error));
  window.webContents.once('did-finish-load', async () => {
    try {
      const actual = await window.webContents.executeJavaScript('(async () => {' +
        'const snapshot = await window.shelf.call("snapshot");' +
        'const documents = await window.shelf.call("library.documents");' +
        'const until = Date.now() + 10000;' +
        'while (!document.querySelector(".ingestion-nav") && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));' +
        'return { snapshot, documents, navigation: document.querySelector(".ingestion-nav")?.textContent, loadedUrl: location.href };' +
      '})()');
      assert.equal(path.resolve(actual.snapshot.settings.dataDir), path.join(fixture, '.local', 'data'));
      assert.equal(actual.snapshot.categories.length, 3);
      assert.deepEqual(actual.snapshot.tasks, []);
      assert.deepEqual(actual.snapshot.conflicts, []);
      assert.deepEqual(actual.documents, []);
      for (const name of ['text', 'vision', 'mediaVision', 'transcription', 'search']) assert.equal(actual.snapshot.settings[name].configured, false);
      assert.equal(actual.snapshot.settings.envFile, undefined);
      assert.match(actual.navigation, /资料入库/);
      assert.equal(window.isVisible(), false);
      assert.equal(visible, false);
      assert.equal(networkRequests, 0);
      finish({ ok: true, categories: actual.snapshot.categories.length, documents: actual.documents.length, navigation: actual.navigation, dataDir: actual.snapshot.settings.dataDir, loadedUrl: actual.loadedUrl });
    } catch (error) { fail(error); }
  });
});
require('./dist/electron/main.cjs');
`);
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    APPDATA: path.join(fixture, 'app-data'), LOCALAPPDATA: path.join(fixture, 'app-data'),
    TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp'),
    HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'),
  });
  let stdout = '', stderr = '', timedOut = false;
  child = spawn(electron, [fixture], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) {
      void promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    } else child.kill('SIGKILL');
  }, 60000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  assert.equal(timedOut, false, 'Hidden Electron startup timed out after 60 seconds.');
  const result = JSON.parse(await readFile(path.join(fixture, 'result.json'), 'utf8').catch(error => {
    throw new Error('No desktop verification result. ' + error.message + '\n' + stdout + '\n' + stderr);
  }));
  assert.equal(result.ok, true, result.error || stderr);
  assert.equal(exit.code, 0, stderr);
  assert.equal(result.visible, false);
  assert.equal(result.windows, 1);
  assert.equal(result.networkRequests, 0);
  for (const marker of ['SHELF_SERVICE_READY', 'SHELF_WINDOW_READY', 'SHELF_UI_CONNECTED']) assert.ok(stdout.includes(marker), 'Missing startup signal: ' + marker);
  console.log('PASS hidden Electron startup: built renderer, preload and real utility service; snapshot RPC; 3 categories, 0 documents; ingestion navigation; isolated configuration; no external requests.');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else child.kill('SIGKILL');
  }
  const actualRoot = await realpath(qaRoot), actualFixture = await realpath(fixture);
  assert.equal((await lstat(fixture)).isSymbolicLink(), false);
  assert.equal(path.dirname(actualFixture).toLowerCase(), actualRoot.toLowerCase());
  assert.equal(actualFixture.toLowerCase(), path.resolve(fixture).toLowerCase());
  assert.ok(path.basename(actualFixture).startsWith('desktop-startup-'));
  await rm(actualFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
