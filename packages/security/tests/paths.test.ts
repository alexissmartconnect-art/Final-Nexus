import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoSymlinkEscape, safeResolve, toWorkspacePath } from '../src/paths.js';
import { NexusError } from '@nexus/shared';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-ws-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

describe('workspace path validation', () => {
  it('resolves a normal relative path inside the workspace', () => {
    const root = tmpRoot();
    expect(safeResolve({ root }, 'src/App.tsx')).toBe(join(root, 'src/App.tsx'));
  });

  it('allows the workspace root itself', () => {
    const root = tmpRoot();
    expect(safeResolve({ root }, './')).toBe(join(root));
  });

  it.each([
    ['../../../etc/passwd'],
    ['..'],
    ['src/../../etc/shadow'],
    ['/etc/passwd'],
    ['C:\\Windows\\System32\\cmd.exe'],
    ['\\\\server\\share\\file'],
    ['src/\u0000/App.tsx'],
    ['.git/config'],
    ['node_modules/x/index.js'],
  ])('rejects %s', (bad) => {
    const root = tmpRoot();
    expect(() => safeResolve({ root }, bad)).toThrow(NexusError);
  });

  it('rejects paths deeper than maxDepth', () => {
    const root = tmpRoot();
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
    expect(() => safeResolve({ root, maxDepth: 10 }, deep)).toThrow(/too deep/);
  });

  it('detects a symlink that escapes the workspace', () => {
    const root = tmpRoot();
    symlinkSync(tmpdir(), join(root, 'escape'));
    expect(() => assertNoSymlinkEscape(root, join(root, 'escape', 'secret.txt'))).toThrow(NexusError);
  });

  it('accepts a symlink that stays inside the workspace', () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'f.txt'), 'ok');
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(() => assertNoSymlinkEscape(root, join(root, 'link', 'f.txt'))).not.toThrow();
  });

  it('converts absolute paths back to workspace keys', () => {
    const root = tmpRoot();
    expect(toWorkspacePath(root, join(root, 'a', 'b.ts'))).toBe('a/b.ts');
    expect(() => toWorkspacePath(root, '/tmp/outside')).toThrow(NexusError);
  });
});
