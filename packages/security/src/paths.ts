import { realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { NexusError } from '@nexus/shared';

export interface PathPolicy {
  /** Absolute path of the workspace root. */
  root: string;
  maxDepth?: number;
  blockedNames?: string[];
}

const DEFAULT_BLOCKED = ['.git', 'node_modules', '.env'];

/**
 * Resolve a workspace-relative path safely.
 * Rejects absolute paths, traversal, NUL bytes, dangerous names and symlink escapes.
 */
export function safeResolve(policy: PathPolicy, relPath: string): string {
  const root = resolve(policy.root);
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new NexusError('unsafe_path', 'Empty path');
  }
  if (relPath.includes('\0')) {
    throw new NexusError('unsafe_path', 'Path contains a NUL byte');
  }
  if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new NexusError('unsafe_path', `Absolute paths are not allowed: ${relPath}`);
  }
  // Normalise to a '/'-separated relative key before any containment check.
  const cleaned = normalize(relPath.replace(/\\/g, '/')).split(sep).join('/');
  const rel = cleaned.replace(/^\.\//, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return root; // the workspace root itself
  if (rel === '..' || rel.startsWith('../') || rel.includes('/../')) {
    throw new NexusError('unsafe_path', `Path escapes the workspace: ${relPath}`);
  }
  const maxDepth = policy.maxDepth ?? 32;
  const segments = rel.split('/');
  if (segments.length > maxDepth) {
    throw new NexusError('unsafe_path', `Path is too deep (max ${maxDepth}): ${relPath}`);
  }
  const blocked = policy.blockedNames ?? DEFAULT_BLOCKED;
  for (const segment of segments) {
    if (blocked.includes(segment)) {
      throw new NexusError('unsafe_path', `Access to "${segment}" is blocked inside a workspace`);
    }
  }
  const target = resolve(root, rel);
  const relCheck = relative(root, target);
  if (relCheck.startsWith('..') || relCheck.split(sep).includes('..')) {
    throw new NexusError('unsafe_path', `Resolved path escapes the workspace: ${relPath}`);
  }
  return target;
}

/** Convert an absolute path back to a workspace-relative, '/'-separated key. */
export function toWorkspacePath(root: string, abs: string): string {
  const rel = relative(resolve(root), resolve(abs));
  if (rel.startsWith('..')) throw new NexusError('unsafe_path', 'Path is outside the workspace');
  return rel.split(sep).join('/');
}

/**
 * Verify that no ancestor of `abs` (up to `root`) is a symlink pointing outside the workspace.
 * Returns true when the path is safe to create/write.
 */
export function assertNoSymlinkEscape(root: string, abs: string): void {
  const rootReal = realpathSync(resolve(root));
  let cursor = dirname(resolve(abs));
  while (cursor.length >= rootReal.length) {
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      break; // does not exist yet: nothing to escape through
    }
    if (st.isSymbolicLink()) {
      const real = realpathSync(cursor);
      const rel = relative(rootReal, real);
      if (rel.startsWith('..')) {
        throw new NexusError('unsafe_path', `Symlink at ${cursor} escapes the workspace`);
      }
    }
    if (cursor === rootReal) break;
    cursor = dirname(cursor);
  }
}

export { join as joinPath };
