import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Inventory {
  root: string;
  headCommit: string | null;
  files: string[];                       // repo-relative, excluding ignored dirs
  languages: Record<string, number>;     // extension -> file count
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  frameworks: string[];
  scripts: Record<string, string>;
  ciWorkflows: string[];
  composeFiles: string[];
  envExamples: string[];
  migrationDirs: string[];
  testDirs: string[];
}

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.turbo', '.cache', 'vendor', '__pycache__', '.venv', 'target', '.shepard',
]);

function walk(root: string, dir: string, out: string[], depth = 0): void {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example') continue;
    if (IGNORED.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out, depth + 1);
    else if (e.isFile()) out.push(relative(root, full));
  }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * A mechanical read of what the repository contains.
 *
 * Nothing here asks a model anything. Enumeration is the one part of discovery
 * that must be exhaustive, and exhaustiveness is what parsers are for.
 */
export function takeInventory(root: string): Inventory {
  const files: string[] = [];
  walk(root, root, files);

  const languages: Record<string, number> = {};
  for (const f of files) {
    const ext = extname(f);
    if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
  }

  let headCommit: string | null = null;
  try {
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch { /* not a git repository, or git unavailable */ }

  const pkg = readJson(join(root, 'package.json'));
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  const frameworks: string[] = [];
  const mark = (dep: string, name: string) => { if (deps[dep]) frameworks.push(name); };
  mark('next', 'next');
  mark('react', 'react');
  mark('vue', 'vue');
  mark('svelte', 'svelte');
  mark('@remix-run/react', 'remix');
  mark('react-router-dom', 'react-router');
  mark('express', 'express');
  mark('fastify', 'fastify');
  mark('@supabase/supabase-js', 'supabase');
  mark('prisma', 'prisma');
  mark('drizzle-orm', 'drizzle');
  mark('vite', 'vite');
  if (existsSync(join(root, 'supabase', 'config.toml'))) frameworks.push('supabase');
  if (existsSync(join(root, 'manage.py'))) frameworks.push('django');
  if (files.some(f => f.endsWith('Gemfile'))) frameworks.push('rails');

  let packageManager: Inventory['packageManager'] = null;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (existsSync(join(root, 'yarn.lock'))) packageManager = 'yarn';
  else if (existsSync(join(root, 'bun.lockb'))) packageManager = 'bun';
  else if (existsSync(join(root, 'package-lock.json')) || pkg) packageManager = 'npm';

  return {
    root,
    headCommit,
    files,
    languages,
    packageManager,
    frameworks: [...new Set(frameworks)],
    scripts: pkg?.scripts ?? {},
    // CI workflows first: they are a working, maintained recipe for building the
    // application, written by people who actually know it.
    ciWorkflows: files.filter(f => /^\.github\/workflows\/.+\.ya?ml$/.test(f)),
    composeFiles: files.filter(f => /(^|\/)(docker-)?compose(\.\w+)?\.ya?ml$/.test(f)),
    envExamples: files.filter(f => /(^|\/)\.env(\.example|\.sample|\.template)?$/.test(f)),
    migrationDirs: [...new Set(
      files.filter(f => /(^|\/)(migrations|migrate)\//.test(f)).map(f => f.replace(/\/[^/]+$/, '')),
    )],
    testDirs: [...new Set(
      files.filter(f => /(^|\/)(tests?|__tests__|e2e|spec)\//.test(f)).map(f => f.replace(/\/[^/]+$/, '')),
    )],
  };
}

export function fileSize(root: string, rel: string): number {
  try { return statSync(join(root, rel)).size; } catch { return 0; }
}
