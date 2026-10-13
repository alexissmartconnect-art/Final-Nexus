import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './root.js';

/**
 * Load environment variables from the repository `.env` file.
 * Uses the Node >= 20.12 built-in loader; no third-party dependency.
 * Returns the file that was loaded, or null when there is none.
 */
export function loadEnvFile(): string | null {
  const candidate = join(findRepoRoot(), '.env');
  if (!existsSync(candidate)) return null;
  try {
    process.loadEnvFile(candidate);
  } catch (err) {
    throw new Error(`Cannot parse ${candidate}: ${(err as Error).message}`);
  }
  return candidate;
}
