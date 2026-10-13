import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the repository root by walking up to the package named `nexus-omega`.
 * Needed because npm runs workspace scripts with cwd = the workspace directory,
 * so relative defaults must not be resolved against cwd.
 */
export function findRepoRoot(start: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(resolve(start));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === 'nexus-omega') return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
