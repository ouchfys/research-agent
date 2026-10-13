import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { projectRoot, qaRoot } from './workspace.mjs';

// A whitelist child cannot discover the user's .env, provider keys or library.
if (!process.argv.includes('--isolated')) {
  const scratch = mkdtempSync(path.join(qaRoot, 'settings-test-'));
  try {
    const env = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { SHELF_TEST_SCRATCH: scratch, SHELF_PROJECT_DIR: scratch, SHELF_ENV_FILE: path.join(scratch, 'none.env') });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], { cwd: scratch, env, encoding: 'utf8', timeout: 120_000 });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    const target = path.resolve(scratch);
    if (path.dirname(target) !== qaRoot || !path.basename(target).startsWith('settings-test-')) throw new Error('Refusing cleanup outside the isolated test directory.');
    rmSync(target, { recursive: true, force: true });
  }
} else {
  const scratch = path.resolve(process.env.SHELF_TEST_SCRATCH);
  assert.equal(path.dirname(scratch), qaRoot);
  assert(path.basename(scratch).startsWith('settings-test-'));
  const output = path.join(scratch, 'settings-test-entry.mjs');
  await build({ stdin: { contents: "export {Config} from './src/server/config'; export {ShelfService} from './src/server/service'; export {Store} from './src/server/store';", resolveDir: projectRoot, loader: 'ts' }, outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { Config, ShelfService, Store } = await import(pathToFileURL(output).href);
  const passed = text => console.log(`PASS ${text}`);
  const configDir = path.join(scratch, 'config'), dataDir = path.join(scratch, 'library');
  let config = new Config(configDir, dataDir);
  const envFile = path.join(scratch, 'test.env');
  writeFileSync(envFile, 'DEEPSEEK_API_KEY=test-deepseek-env\nDASHSCOPE_API_KEY=test-aliyun-env\nMINERU_API_TOKEN=test-mineru-env\n');
  config.importEnvFile(envFile);
  delete process.env.SHELF_ENV_FILE; // Restart must actually reread this associated fixture.
  const initialPublic = JSON.stringify(config.public());
  assert(!initialPublic.includes('test-deepseek-env'));
  assert(!initialPublic.includes('test-mineru-env'));
  assert.equal(config.public().paperParsing.mineru.source, 'env');
  config.save({ providerKeys: { deepseek: 'test-deepseek-manual', aliyun: 'test-aliyun-manual' }, paperParsing: { mineru: { apiToken: 'test-mineru-manual' } } });
  config.save({ providerKeys: { deepseek: '  ', aliyun: '' }, paperParsing: { mineru: { apiToken: '' } } });
  config = new Config(configDir, dataDir);
  assert.equal(config.get().text.apiKey, 'test-deepseek-manual');
  assert.equal(config.get().transcription.apiKey, 'test-aliyun-manual');
  assert.equal(config.get().paperParsing.mineru.apiToken, 'test-mineru-manual');
  assert.equal(config.public().paperParsing.mineru.source, 'saved');
  for (const secret of ['test-deepseek-manual', 'test-aliyun-manual', 'test-mineru-manual']) assert(!JSON.stringify(config.public()).includes(secret));
  passed('官方密钥只填一次；空白保留；手填 MinerU Token 重启后不被 .env 覆盖，公开配置不含密钥');

  const savedBefore = readFileSync(config.file, 'utf8');
  assert.throws(() => config.save({ providerKeys: { deepseek: 'conflicting-key' }, text: { provider: 'deepseek', apiKey: 'other-key' } }), /不同的 API Key/);
  assert.throws(() => config.save({ providerKeys: { deepseek: 'broken\nkey' } }), /单行密钥/);
  assert.equal(readFileSync(config.file, 'utf8'), savedBefore);
  config.save({ text: { provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'custom-secret' } });
  assert.equal(config.get().text.apiKey, 'custom-secret');
  config.save({ text: { provider: 'custom', baseUrl: 'https://different.invalid/v1', apiKey: '' } });
  assert.equal(config.get().text.apiKey, '');
  config.save({ text: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '' } });
  assert.equal(config.get().text.apiKey, 'test-deepseek-manual');
  config.reloadEnv();
  assert.equal(config.get().text.apiKey, 'test-deepseek-env');
  assert.equal(config.get().paperParsing.mineru.apiToken, 'test-mineru-env');
  passed('冲突和无效密钥不保存；切换兼容服务地址不沿用旧密钥；主动重载 .env 才替换手填值');

  const modelEnv = path.join(scratch, 'models.env');
  writeFileSync(modelEnv, 'DEEPSEEK_API_KEY=test-shared-deepseek\nDASHSCOPE_API_KEY=test-shared-aliyun\nTEXT_MODEL=deepseek-v4-pro\nVISION_USE_TEXT_MODEL=false\nVISION_BASE_URL=https://api.deepseek.com\nVISION_MODEL=deepseek-flash\nTRANSCRIPTION_MODEL=fixture-asr-model\n');
  config.importEnvFile(modelEnv);
  assert.equal(config.get().text.model, 'deepseek-v4-pro');
  assert.equal(config.get().text.apiKey, 'test-shared-deepseek');
  assert.equal(config.get().vision.useTextModel, false);
  assert.equal(config.get().vision.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.get().vision.model, 'deepseek-flash');
  assert.equal(config.get().vision.apiKey, 'test-shared-deepseek');
  assert.equal(config.get().transcription.model, 'fixture-asr-model');
  assert.equal(config.get().transcription.apiKey, 'test-shared-aliyun');
  writeFileSync(modelEnv, 'TEXT_MODEL=deepseek-flash\nTRANSCRIPTION_MODEL=qwen3-asr-flash\n');
  config.reloadEnv();
  assert.equal(config.get().text.model, 'deepseek-flash');
  assert.equal(config.get().transcription.model, 'qwen3-asr-flash');
  config = new Config(configDir, dataDir);
  assert.equal(config.get().text.model, 'deepseek-flash');
  assert.equal(config.get().vision.useTextModel, false);
  const beforeInvalidEnv = readFileSync(config.file, 'utf8');
  writeFileSync(modelEnv, 'TEXT_MODEL=deepseek-v4-pro\nVISION_USE_TEXT_MODEL=true\n');
  assert.throws(() => config.reloadEnv(), /不支持图片/);
  assert.equal(readFileSync(config.file, 'utf8'), beforeInvalidEnv);
  writeFileSync(modelEnv, 'TRANSCRIPTION_BASE_URL=https://api.deepseek.com\n');
  assert.throws(() => config.reloadEnv(), /语音转写请选择/);
  assert.equal(readFileSync(config.file, 'utf8'), beforeInvalidEnv);
  passed('.env 使用官方共享密钥时模型和地址仍可独立导入/重载；视觉与 ASR 校验和设置保存一致，失败不落盘');

  config.save({ paperParsing: { mineru: { baseUrl: 'https://pdf.example.invalid/api', apiToken: '' } } });
  assert.equal(config.get().paperParsing.mineru.apiToken, '');
  assert.equal(config.public().paperParsing.mineru.source, 'none');
  config.save({ paperParsing: { mineru: { apiToken: 'test-new-parser-key' } } });
  config.save({ paperParsing: { mineru: { baseUrl: 'https://pdf.example.invalid/v2' } } });
  assert.equal(config.get().paperParsing.mineru.apiToken, 'test-new-parser-key');
  const parserEnv = path.join(scratch, 'parser.env');
  writeFileSync(parserEnv, 'MINERU_API_BASE_URL=https://different.example.invalid/api\n');
  config.importEnvFile(parserEnv);
  assert.equal(config.get().paperParsing.mineru.apiToken, '');
  assert.equal(config.public().paperParsing.mineru.source, 'none');
  config = new Config(configDir, dataDir);
  assert.equal(config.get().paperParsing.mineru.apiToken, '');
  passed('MinerU 跨来源地址变更不沿用旧 Token，同来源路径调整保留 Token，来源状态与重启一致');

  const brokenDir = path.join(scratch, 'broken-config'); mkdirSync(brokenDir);
  writeFileSync(path.join(brokenDir, 'settings.json'), '{"providerKeys":{"deepseek":"sensitive-invalid-json');
  assert.throws(() => new Config(brokenDir, dataDir), error => !error.message.includes('sensitive') && /无法读取/.test(error.message));
  assert.throws(() => config.importEnvFile(scratch), /无法读取配置文件/);
  passed('损坏设置和错误 .env 路径不会在错误信息中回显配置内容');

  // Keep rename/copy fixtures outside the repository's live Vite file watcher.
  const temporaryRoot = realpathSync(tmpdir()), storageBase = mkdtempSync(path.join(temporaryRoot, 'settings-library-test-'));
  const service = new ShelfService(path.join(scratch, 'service-config'), path.join(storageBase, 'source-library'), () => {});
  const inspect = dataDir => service.call('storage.inspect', { dataDir });
  const source = service.store.dataDir;
  try {
    const current = await inspect(source);
    assert.equal(current.status, 'current'); assert.equal(current.canCopy, false); assert.equal(current.canOpen, false);
    const missing = path.join(storageBase, 'new-parent', 'new-library');
    const missingResult = await inspect(missing);
    assert.equal(missingResult.status, 'missing'); assert.equal(missingResult.recommendedMode, 'move');
    assert.equal(existsSync(path.dirname(missing)), false);
    const empty = path.join(storageBase, 'empty-library'); mkdirSync(empty);
    assert.equal((await inspect(empty)).status, 'empty'); assert.deepEqual(readdirSync(empty), []);
    const unrelated = path.join(storageBase, 'unrelated'); mkdirSync(unrelated); writeFileSync(path.join(unrelated, 'personal.txt'), 'untouched');
    assert.equal((await inspect(unrelated)).status, 'invalid');
    assert.equal((await inspect(path.join(source, 'nested'))).status, 'invalid');
    assert.equal((await inspect('relative-location')).status, 'invalid');
    if (process.platform === 'win32') assert.equal((await inspect(path.join(storageBase, 'bad?folder'))).status, 'invalid');
    assert.equal(readFileSync(path.join(unrelated, 'personal.txt'), 'utf8'), 'untouched');
    passed('目录预检识别当前、空目录、新目录和无效目录；不创建目录、不移动文件');

    const existingPath = path.join(storageBase, 'existing-library'), existing = new Store(existingPath);
    const originalDoc = existing.saveManual({ title: '已有资料', categoryId: 'agent', description: '用于验证已有知识库预检。', aliases: [], paperIds: [], sources: [], body: '# 已有资料\n\n正文', expectedVersion: 0 });
    const liveWal = readFileSync(path.join(existingPath, 'app.sqlite-wal'));
    const liveDatabase = readFileSync(path.join(existingPath, 'app.sqlite'));
    assert.equal((await inspect(existingPath)).documentCount, 1);
    assert.deepEqual(readFileSync(path.join(existingPath, 'app.sqlite')), liveDatabase);
    assert.deepEqual(readFileSync(path.join(existingPath, 'app.sqlite-wal')), liveWal);
    existing.close();
    const beforeDatabase = readFileSync(path.join(existingPath, 'app.sqlite'));
    const beforeListing = readdirSync(existingPath).sort();
    const found = await inspect(existingPath);
    assert.equal(found.status, 'library'); assert.equal(found.documentCount, 1); assert.equal(found.canCopy, false); assert.equal(found.canOpen, true);
    assert.deepEqual(readFileSync(path.join(existingPath, 'app.sqlite')), beforeDatabase);
    assert.deepEqual(readdirSync(existingPath).sort(), beforeListing);
    assert.equal(service.store.dataDir, source);
    await service.call('storage.switch', { dataDir: existingPath, mode: 'open' });
    assert.equal(service.store.document(originalDoc.id).title, '已有资料');
    assert(existsSync(path.join(source, 'app.sqlite')));
    const copiedPath = path.join(storageBase, 'copied-library');
    await service.call('storage.switch', { dataDir: copiedPath, mode: 'move' });
    assert.equal(service.store.document(originalDoc.id).body, '# 已有资料\n\n正文');
    assert(existsSync(path.join(existingPath, 'app.sqlite')));
    assert.equal(service.config.public().dataDir, copiedPath);
    assert.equal((await service.call('settings.get')).dataDir, copiedPath);
    passed('已有库预检只读且统计文档正确；打开和复制后服务即时切换，原库完整保留');
  } finally {
    await service.close();
    if (path.dirname(storageBase) !== temporaryRoot || !path.basename(storageBase).startsWith('settings-library-test-')) throw new Error('Refusing cleanup outside isolated storage fixtures.');
    rmSync(storageBase, { recursive: true, force: true });
  }
}
