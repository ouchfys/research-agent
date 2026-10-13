import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const qaRoot = path.join(projectRoot, '.cache', 'qa');
mkdirSync(qaRoot, { recursive: true });
if (realpathSync(qaRoot).toLowerCase() !== qaRoot.toLowerCase()) throw new Error('QA cache must be a real directory inside the project.');
