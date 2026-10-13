import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only reproducible build/test/download output belongs here. Never include
// .local, release, tools, .env, or the configured knowledge library.
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const targets = ['dist', '.cache/media', '.cache/qa', '.cache/tests'];
const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
  throw new Error('Usage: npm run clean [-- --apply | --dry-run]');
}
const apply = args.includes('--apply');

const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function intersects(left, right) { return contains(left, right) || contains(right, left); }

// A saved library may not exist yet, or may be reached through a junction.
// Resolve the existing ancestor while retaining any missing suffix.
async function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try { return path.join(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function protectedLocations() {
  const locations = [path.join(root, '.local')];
  for (const name of ['SHELF_DATA_DIR', 'SHELF_DEFAULT_DATA_DIR']) {
    if (process.env[name]?.trim()) locations.push(path.resolve(process.env[name]));
  }
  const settingsFiles = [path.join(root, '.local', 'config', 'settings.json')];
  if (process.env.APPDATA) settingsFiles.push(path.join(process.env.APPDATA, '研究书架', 'settings.json'));
  if (process.env.SHELF_CONFIG_DIR) settingsFiles.push(path.resolve(process.env.SHELF_CONFIG_DIR, 'settings.json'));
  for (const file of new Set(settingsFiles)) {
    let settings;
    try {
      const info = await lstat(file);
      if (info.size > 1024 * 1024) throw new Error('Oversized settings');
      settings = JSON.parse(await readFile(file, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
      if (settings.dataDir !== undefined && (typeof settings.dataDir !== 'string' || !settings.dataDir.trim())) throw new Error('Invalid library location');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      // Never include JSON parser diagnostics or settings contents: they can contain keys.
      throw new Error(`Cannot safely read the library location from settings: ${file}`);
    }
    if (settings.dataDir) {
      locations.push(path.resolve(settings.dataDir));
      // Conservatively also protect a project-relative interpretation when run elsewhere.
      if (!path.isAbsolute(settings.dataDir)) locations.push(path.resolve(root, settings.dataDir));
    }
  }
  const protectedPaths = [];
  for (const location of locations) protectedPaths.push(path.resolve(location), await canonicalPath(location));
  return protectedPaths;
}

let protectedPaths = await protectedLocations();
async function inspect(target) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing linked cleanup path: ${target}`);
  const resolved = await realpath(target);
  // Checking only the final entry misses a junction in a parent such as .cache.
  if (!samePath(resolved, path.resolve(target))) throw new Error(`Refusing redirected cleanup path: ${target}`);
  if (protectedPaths.some(location => intersects(location, target) || intersects(location, resolved))) {
    throw new Error(`Cleanup target intersects a protected library or persistent directory: ${target}`);
  }
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Cleanup path escapes project: ${target}`);
  }
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  if (!stat.isDirectory()) throw new Error(`Unsupported cleanup entry: ${target}`);
  const result = { bytes: 0, files: 0 };
  for (const name of await readdir(target)) {
    const child = await inspect(path.join(target, name));
    result.bytes += child.bytes;
    result.files += child.files;
  }
  return result;
}

// Inspect every target before removing anything; missing output is normal.
const plan = [];
for (const name of targets) {
  const target = path.resolve(root, name);
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  plan.push({ name, target, ...await inspect(target) });
}
for (const item of plan) {
  if (apply) {
    protectedPaths = await protectedLocations();
    await inspect(item.target);
    await rm(item.target, { recursive: true });
  }
  console.log(`${apply ? 'Removed' : 'Would remove'} ${item.name}: ${item.files} files, ${item.bytes} bytes`);
}
if (!plan.length) console.log('No generated files to clean.');
if (!apply) console.log('Preview only. Run npm run clean -- --apply to remove the listed output.');
