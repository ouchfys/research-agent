import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const archive = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'release/win-unpacked/resources/app.asar');
const digest = value => createHash('sha256').update(value).digest('hex');
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const checked = files(path.join(projectRoot, 'dist')).map(file => {
  // @electron/asar resolves archive entries using the host path separator.
  const relative = path.relative(projectRoot, file);
  assert.equal(digest(extractFile(archive, relative)), digest(readFileSync(file)), 'Packaged dist differs: ' + relative);
  return relative.replaceAll('\\', '/');
});
console.log(JSON.stringify({ archive, checkedFiles: checked.length, matchesBuild: true }));
