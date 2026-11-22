// The PRs card's server side. The list comes from the open-PR cache shared
// with other bb plugins (pr-cache.ts), filled through the user's own `gh` CLI
// so its sign-in does the auth and no token passes through the plugin. Also
// opens a PR in the system's default browser, which bb's own URL opener does
// not: it prefers bb's built-in browser.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { readCache, refreshOpenPrs, type CacheDeps, type CacheFile, type GhResult } from "./pr-cache";
import { parsePullRequests, type PrsResult } from "./prs";

/** bb launched from the Dock gets a bare PATH; look where Homebrew installs gh too. */
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
export const CACHE_DIR = join(homedir(), ".cache", "bb-prs");

export async function gh(args: string[]): Promise<GhResult> {
  try {
    const { stdout, stderr } = await promisify(execFile)("gh", args, {
      timeout: 15_000,
      env: { ...process.env, PATH, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const deps: CacheDeps = { dir: CACHE_DIR, now: Date.now, gh };

function toResult(cache: CacheFile): PrsResult {
  const problem = cache.lastError?.kind ?? null;
  if (cache.fetchedAt === null || cache.data === null) return { status: problem ?? "pending" };
  let prs;
  try {
    prs = parsePullRequests({ data: cache.data });
  } catch {
    return { status: "error" };
  }
  return {
    status: "ok",
    prs,
    observedAt: cache.fetchedAt,
    problem,
    retryAt: problem ? cache.nextAllowedAt : null,
  };
}

let refreshing: Promise<CacheFile> | null = null;

/**
 * The user's open PRs. `refresh` lets this call fetch from GitHub, which the
 * shared cache allows only when its data is stale, no backoff is pending,
 * and no other fetch holds the lock. Without it the call only reads the cache.
 */
export async function myPullRequests(refresh: boolean, warn: (message: string) => void): Promise<PrsResult> {
  if (!refresh) return toResult(await readCache(CACHE_DIR));
  refreshing ??= (async () => {
    const started = Date.now();
    try {
      const cache = await refreshOpenPrs(deps);
      if (cache.lastError && cache.lastError.at >= started)
        warn(`PR fetch failed (${cache.lastError.kind}): ${cache.lastError.message}`);
      return cache;
    } finally {
      refreshing = null;
    }
  })();
  return toResult(await refreshing);
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const OPENER: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", linux: "xdg-open" };

/** Opens a GitHub PR URL in the default browser; false if the URL or platform isn't supported. */
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = OPENER[process.platform];
  if (!opener || !PR_URL.test(url)) return false;
  try {
    await promisify(execFile)(opener, [url], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
