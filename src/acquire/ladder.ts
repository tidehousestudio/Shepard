import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Level } from '../knowledge/types.js';
import type { Inventory } from '../discover/inventory.js';

export interface Unmet { level: Level; need: string; detail?: string }

export interface Acquisition {
  level: Level;
  baseUrl: string | null;
  recipe: Recipe;
  unmet: Unmet[];
  stop: () => Promise<void>;
}

export interface Recipe {
  install?: string[];
  build?: string[];
  start?: string[];
  port?: number;
  env?: string[];          // names only. Shepard never stores secret values.
  source: string;          // where the recipe came from
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Derive a build-and-boot recipe from evidence in the repository.
 *
 * Order matters and is not arbitrary. CI workflows come first because they are a
 * working recipe maintained by people who know the application; a README can be
 * years out of date, but a green pipeline cannot.
 */
export function deriveRecipe(inv: Inventory): Recipe {
  const pm = inv.packageManager ?? 'npm';
  const runner = pm === 'npm' ? ['npm', 'run'] : [pm, 'run'];

  const envNames = new Set<string>();
  for (const f of inv.envExamples) {
    try {
      const txt = readFileSync(join(inv.root, f), 'utf8');
      for (const m of txt.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)) envNames.add(m[1]!);
    } catch { /* unreadable example file is itself worth nothing here */ }
  }

  const has = (s: string) => Boolean(inv.scripts[s]);
  const start =
    has('start') ? [...runner, 'start'] :
    has('dev') ? [...runner, 'dev'] :
    has('serve') ? [...runner, 'serve'] : undefined;

  return {
    install: existsSync(join(inv.root, 'package.json'))
      ? [pm, pm === 'npm' ? 'install' : 'install'] : undefined,
    build: has('build') ? [...runner, 'build'] : undefined,
    start,
    env: [...envNames],
    source: inv.ciWorkflows.length ? `ci:${inv.ciWorkflows[0]}`
          : inv.composeFiles.length ? `compose:${inv.composeFiles[0]}`
          : 'package.json scripts',
  };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

/**
 * Climb the capability ladder as far as this repository and environment allow,
 * and record precisely where the climb stopped.
 *
 * "Failed to run" is not a useful state. "Reached boots; needs DATABASE_URL and
 * two API keys to reach persists" is, because the user can act on it and because
 * Shepard can scope its coverage honestly to what it could actually exercise.
 */
export async function acquire(
  inv: Inventory,
  opts: { baseUrl?: string; port?: number; skipInstall?: boolean; timeoutMs?: number } = {},
): Promise<Acquisition> {
  const recipe = deriveRecipe(inv);
  const unmet: Unmet[] = [];
  let level = Level.Static;
  let child: ChildProcess | null = null;
  const stop = async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await sleep(300);
      if (!child.killed) child.kill('SIGKILL');
    }
  };

  // An already-running instance the caller supplied. Trusting it is fine: the
  // caller is responsible for it being a disposable one.
  if (opts.baseUrl) {
    const up = await waitForHttp(opts.baseUrl, 10_000);
    if (up) {
      level = Level.Boots;
      return { level, baseUrl: opts.baseUrl, recipe, unmet, stop };
    }
    unmet.push({ level: Level.Boots, need: 'a reachable base URL', detail: `${opts.baseUrl} did not respond` });
    return { level, baseUrl: null, recipe, unmet, stop };
  }

  if (!recipe.install) {
    unmet.push({ level: Level.Builds, need: 'a recognised package manifest' });
    return { level, baseUrl: null, recipe, unmet, stop };
  }

  if (!opts.skipInstall) {
    try {
      execFileSync(recipe.install[0]!, recipe.install.slice(1),
        { cwd: inv.root, stdio: 'ignore', timeout: 300_000 });
    } catch {
      unmet.push({ level: Level.Builds, need: 'dependency installation to succeed' });
      return { level, baseUrl: null, recipe, unmet, stop };
    }
  }

  if (recipe.build) {
    try {
      execFileSync(recipe.build[0]!, recipe.build.slice(1),
        { cwd: inv.root, stdio: 'ignore', timeout: 600_000 });
      level = Level.Builds;
    } catch {
      // A build failure is not merely a blocked ladder: it is a finding in its
      // own right, and the caller records it as one.
      unmet.push({ level: Level.Builds, need: 'the build to succeed' });
      return { level, baseUrl: null, recipe, unmet, stop };
    }
  } else {
    level = Level.Builds;
  }

  if (!recipe.start) {
    unmet.push({ level: Level.Boots, need: 'a start, dev or serve script' });
    return { level, baseUrl: null, recipe, unmet, stop };
  }

  const port = opts.port ?? 3000;
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(recipe.start[0]!, recipe.start.slice(1), {
    cwd: inv.root,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
  });

  if (await waitForHttp(baseUrl, opts.timeoutMs ?? 60_000)) {
    level = Level.Boots;
  } else {
    unmet.push({
      level: Level.Boots,
      need: 'the application to answer on its port',
      detail: recipe.env?.length
        ? `it may need configuration: ${recipe.env.slice(0, 8).join(', ')}`
        : undefined,
    });
    await stop();
    return { level: Level.Builds, baseUrl: null, recipe, unmet, stop };
  }

  // Levels 3 to 5 need a provisioned database, test identities and outbound
  // stubs. Each is reported as an explicit gap rather than quietly skipped,
  // because behaviour Shepard could not reach must never read as healthy.
  unmet.push({ level: Level.Persists, need: 'a provisioned test database for database-level assertions' });
  unmet.push({ level: Level.Authenticated, need: 'test identities for each discovered role' });
  unmet.push({ level: Level.Integrated, need: 'outbound integration stubs' });

  return { level, baseUrl, recipe, unmet, stop };
}
