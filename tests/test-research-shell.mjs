// Local-only regression checks. No network, model API, or live library access.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot, qaRoot } from './workspace.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const moduleDir = await mkdtemp(path.join(qaRoot, 'research-shell-test-'));
const compiled = path.join(moduleDir, 'research-shell.mjs');
const tempRoot = await realpath(os.tmpdir());
const library = await mkdtemp(path.join(tempRoot, 'bookshelf-shell-test-'));
const previousSecret = process.env.RESEARCH_SHELL_TEST_SECRET;
const previousSession = process.env.PI_SESSION_ID;
const marker = 'fake-test-secret-never-a-real-key';
const handles = [];
const observations = [];
const windows = process.platform === 'win32';

function restore(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
async function missing(filename) {
  await assert.rejects(readFile(filename), error => error.code === 'ENOENT');
}
async function waitUntil(fn, message, milliseconds = 6000) {
  const end = Date.now() + milliseconds;
  do { if (await fn()) return; await delay(60); } while (Date.now() < end);
  throw new Error(message);
}

try {
  await build({ entryPoints: [path.join(projectRoot, 'src/server/research-shell.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22', logLevel: 'silent' });
  const { createResearchShell } = await import(pathToFileURL(compiled).href);
  process.env.RESEARCH_SHELL_TEST_SECRET = marker;
  process.env.PI_SESSION_ID = 'fake-host-session';
  const makeShell = async signal => {
    const handle = await createResearchShell({ dataDir: library, signal, check: () => {}, redact: value => value.replaceAll(marker, '[REDACTED]'), onResult: async result => { observations.push(result); return 'test-material'; } });
    handles.push(handle);
    return handle;
  };
  const shell = await makeShell();
  const execute = (handle, command, timeout = 20) => handle.tool.execute('test-call', { command, timeout }, undefined, undefined, { cwd: library });
  const probe = windows
    ? `[pscustomobject]@{cwd=(Get-Location).Path;workspace=$env:SHELF_WORKSPACE;home=$env:HOME;secret=$env:RESEARCH_SHELL_TEST_SECRET;session=$env:PI_SESSION_ID;gitConfig=$env:GIT_CONFIG_GLOBAL}|ConvertTo-Json -Compress`
    : `printf '{"cwd":"%s","workspace":"%s","home":"%s","secret":"%s","session":"%s","gitConfig":"%s"}\\n' "$PWD" "$SHELF_WORKSPACE" "$HOME" "$RESEARCH_SHELL_TEST_SECRET" "$PI_SESSION_ID" "$GIT_CONFIG_GLOBAL"`;
  await execute(shell, probe);
  const scope = JSON.parse(observations.at(-1).output.trim());
  assert.equal(scope.cwd, scope.workspace, 'actual process cwd is the temporary workspace');
  assert(within(path.join(library, 'research-scratch'), scope.cwd));
  assert(within(scope.cwd, scope.home));
  assert(within(scope.cwd, scope.gitConfig));
  assert(!scope.secret && !scope.session, 'host secrets and Pi session metadata are not inherited');
  await execute(shell, windows ? `[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'probe.txt'),'temporary')` : `printf 'temporary' > probe.txt`);
  assert.equal(await readFile(path.join(scope.cwd, 'probe.txt'), 'utf8'), 'temporary');

  const verbose = windows
    ? `[Console]::WriteLine('${marker}'); 1..1800 | ForEach-Object { [Console]::WriteLine(('x' * 200)) }`
    : `printf '%s\\n' '${marker}'; for i in {1..1800}; do printf '%0200d\\n' 0; done`;
  const output = await execute(shell, verbose);
  const observed = observations.at(-1);
  assert(observed.outputTruncated);
  assert(Buffer.byteLength(observed.output) <= 24 * 1024);
  assert(observed.output.split('\n').length <= 1000);
  assert(!JSON.stringify(output).includes(marker) && !observed.output.includes(marker));
  assert(output.structuredContent?.truncated);
  assert(!output.structuredContent?.full_output_path, 'bounded output does not spill to a global temporary log');
  const nonzero = await execute(shell, windows ? `[Console]::WriteLine('nonzero'); exit 7` : `printf 'nonzero\\n'; exit 7`);
  assert.equal(observations.at(-1).exitCode, 7);
  assert(nonzero.isError, 'nonzero exits remain errors');
  await assert.rejects(execute(shell, windows ? 'Start-Sleep -Seconds 20' : 'sleep 20', 0.25), /timed out|timeout/i);
  await shell.cleanup();
  await shell.cleanup();
  await missing(path.join(scope.cwd, 'probe.txt'));
  assert.deepEqual(await readdir(path.join(library, 'research-scratch')), []);
  await assert.rejects(execute(shell, 'echo invalid'), /清理/);

  const controller = new AbortController();
  const cancelShell = await makeShell(controller.signal);
  const scratchNames = await readdir(path.join(library, 'research-scratch'));
  assert.equal(scratchNames.length, 1);
  const cancelledWorkspace = path.join(library, 'research-scratch', scratchNames[0]);
  const pidFile = path.join(cancelledWorkspace, 'child.pid');
  const cancelCommand = windows
    ? `[IO.File]::WriteAllText((Join-Path $env:SHELF_WORKSPACE 'child.pid'),$PID.ToString()); Start-Sleep -Seconds 30; [IO.File]::WriteAllText((Join-Path $env:SHELF_WORKSPACE 'should-not-exist'),'bad')`
    : `printf '%s' "$$" > child.pid; sleep 30; printf 'bad' > should-not-exist`;
  const running = execute(cancelShell, cancelCommand, 40);
  // Attach the rejection assertion before aborting to avoid unhandled rejections.
  const cancelled = assert.rejects(running);
  let childPid;
  await waitUntil(async () => {
    try { childPid = Number(await readFile(pidFile, 'utf8')); return Number.isSafeInteger(childPid) && childPid > 0; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'shell did not write its process id');
  controller.abort(new Error('test cancellation'));
  await cancelled;
  await waitUntil(async () => { try { process.kill(childPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'cancelled shell process is still alive');
  await missing(path.join(cancelledWorkspace, 'should-not-exist'));
  await cancelShell.cleanup();
  assert.deepEqual(await readdir(path.join(library, 'research-scratch')), []);
  console.log('PASS: local cwd, isolated inherited environment, output limits/redaction, nonzero exit, timeout, cancellation and temporary cleanup.');
  console.log('This validates local execution hygiene; it does not assert OS sandbox isolation.');
} finally {
  restore('RESEARCH_SHELL_TEST_SECRET', previousSecret);
  restore('PI_SESSION_ID', previousSession);
  for (const handle of handles) await handle.cleanup();
  // Delete only this test-created, canonical direct child of the OS temp directory.
  const actualLibrary = await realpath(library);
  assert.equal(path.dirname(actualLibrary).toLowerCase(), tempRoot.toLowerCase());
  assert(path.basename(actualLibrary).startsWith('bookshelf-shell-test-'));
  await rm(actualLibrary, { recursive: true, force: true });
  await unlink(compiled).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(moduleDir);
}
