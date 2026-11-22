// Link previews' server side: a site's favicon and a page's title card, both
// cached in plugin KV so a long thread doesn't refetch them. GitHub PRs,
// issues and commits come from the user's own `gh` (read-only API calls), PRs
// from the shared open-PR cache first. Pages are fetched https only, without
// cookies, with a timeout and a size cap.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { domainOf, githubRef, type GithubRef } from "./link-label";
import { readCache } from "./pr-cache";
import { parsePullRequests } from "./prs";
import { CACHE_DIR, gh } from "./prs-source";

type Kv = BbPluginApi["storage"]["kv"];

const HOUR = 60 * 60 * 1000;
const PAGE_TTL = 24 * HOUR;
const GITHUB_TTL = HOUR;
const FAVICON_TTL = 7 * 24 * HOUR;
const FAILED_TTL = HOUR;
const PAGE_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;

export const GITHUB_STATES = ["open", "draft", "merged", "closed"] as const;

export const linkPreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    domain: z.string(),
    title: z.string(),
    description: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("github"),
    domain: z.string(),
    /** "owner/repo#168" or "owner/repo@1a2b3c4". */
    ref: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    state: z.enum(GITHUB_STATES).nullable(),
    additions: z.number().nullable(),
    deletions: z.number().nullable(),
  }),
]);
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

const cachedSchema = z.object({ at: z.number(), ttl: z.number(), value: z.unknown() });

const inflight = new Map<string, Promise<unknown>>();

/** A KV-cached value; concurrent asks for one key share a single load. */
function cached<T>(kv: Kv, key: string, load: () => Promise<{ value: T; ttl: number }>): Promise<T> {
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = readThrough(kv, key, load).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function readThrough<T>(kv: Kv, key: string, load: () => Promise<{ value: T; ttl: number }>): Promise<T> {
  const hit = cachedSchema.safeParse(await kv.get(key));
  if (hit.success && Date.now() - hit.data.at < hit.data.ttl) return hit.data.value as T;
  const { value, ttl } = await load();
  await kv.set(key, { at: Date.now(), ttl, value });
  return value;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
const IP = /^[\d.]+$|:/;

/** A public https URL worth fetching: no IP literals, localhost or private names. */
export function fetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (IP.test(host) || !DOMAIN.test(host) || /\.(local|internal|localhost)$/.test(host)) return null;
  return url;
}

export function validDomain(domain: string): boolean {
  return DOMAIN.test(domain) && !/\.(local|internal|localhost)$/.test(domain);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const clean = (s: string | undefined, max: number) => {
  const text = s ? decodeEntities(s).replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The OpenGraph title and description, falling back to <title> and the meta description. */
export function pageMeta(html: string): { title: string | null; description: string | null } {
  const meta: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (key && content) meta[(key[2] ?? key[3])!.toLowerCase()] ??= (content[2] ?? content[3])!;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: clean(meta["og:title"] ?? meta["twitter:title"] ?? titleTag, 140),
    description: clean(meta["og:description"] ?? meta["twitter:description"] ?? meta.description, 240),
  };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, PAGE_BYTES));
}

async function pagePreview(url: URL): Promise<LinkPreview | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    credentials: "omit",
    headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; bb-link-preview)" },
  });
  if (!res.ok || !fetchableUrl(res.url) || !/html/.test(res.headers.get("content-type") ?? "")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const { title, description } = pageMeta(await readCapped(res));
  return title ? { kind: "page", domain: domainOf(url), title, description } : null;
}

async function ghJson(path: string, jq: string): Promise<Record<string, unknown> | null> {
  const result = await gh(["api", "--method", "GET", path, "--jq", jq]);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** An open PR of the user's, from the cache the PRs card already keeps fresh. */
async function cachedPr(url: string): Promise<LinkPreview | null> {
  const cache = await readCache(CACHE_DIR);
  if (cache.data === null) return null;
  try {
    const pr = parsePullRequests({ data: cache.data }).find((p) => p.url === url);
    if (!pr) return null;
    return {
      kind: "github",
      domain: "github.com",
      ref: `${pr.repo}#${pr.number}`,
      title: pr.title,
      description: null,
      state: pr.draft ? "draft" : "open",
      additions: pr.additions,
      deletions: pr.deletions,
    };
  } catch {
    return null;
  }
}

async function githubPreview(ref: GithubRef): Promise<LinkPreview | null> {
  const base = { kind: "github", domain: "github.com", description: null, state: null, additions: null, deletions: null } as const;
  if (ref.kind === "pr") {
    const pr = await ghJson(`repos/${ref.repo}/pulls/${ref.id}`, "{title,state,merged,draft,additions,deletions}");
    if (!pr || !str(pr.title)) return null;
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
    return { ...base, ref: `${ref.repo}#${ref.id}`, title: str(pr.title)!, state, additions: num(pr.additions), deletions: num(pr.deletions) };
  }
  if (ref.kind === "issue") {
    const issue = await ghJson(`repos/${ref.repo}/issues/${ref.id}`, "{title,state}");
    if (!issue || !str(issue.title)) return null;
    return { ...base, ref: `${ref.repo}#${ref.id}`, title: str(issue.title)!, state: issue.state === "closed" ? "closed" : "open" };
  }
  if (ref.kind === "commit") {
    const commit = await ghJson(`repos/${ref.repo}/commits/${ref.id}`, "{message: .commit.message, additions: .stats.additions, deletions: .stats.deletions}");
    const message = str(commit?.message);
    if (!message) return null;
    const [subject, ...body] = message.split("\n");
    return {
      ...base,
      ref: `${ref.repo}@${ref.id.slice(0, 7)}`,
      title: subject!,
      description: clean(body.join(" "), 240),
      additions: num(commit!.additions),
      deletions: num(commit!.deletions),
    };
  }
  const repo = await ghJson(`repos/${ref.repo}`, "{full_name,description}");
  if (!repo || !str(repo.full_name)) return null;
  return { ...base, ref: str(repo.full_name)!, title: str(repo.full_name)!, description: str(repo.description) };
}

export function linkPreview(kv: Kv, raw: string): Promise<LinkPreview | null> {
  const url = fetchableUrl(raw);
  if (!url) return Promise.resolve(null);
  const ref = githubRef(url);
  return cached(kv, `link-preview:${hash(url.href)}`, async () => {
    const value = ref
      ? (ref.kind === "pr" ? await cachedPr(url.href) : null) ?? (await githubPreview(ref))
      : await pagePreview(url).catch(() => null);
    return { value, ttl: value ? (ref ? GITHUB_TTL : PAGE_TTL) : FAILED_TTL };
  });
}

type Favicon = { type: string; base64: string } | null;

/** The site's favicon through Google's favicon service, fetched once a week per domain. */
export async function favicon(kv: Kv, domain: string): Promise<Favicon> {
  if (!validDomain(domain)) return null;
  return cached<Favicon>(kv, `favicon:${domain}`, async () => {
    try {
      const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const type = res.headers.get("content-type") ?? "";
      // An unknown site gets Google's globe with a 404, which is still the right icon.
      if (!type.startsWith("image/")) return { value: null, ttl: FAILED_TTL };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 64 * 1024) return { value: null, ttl: FAVICON_TTL };
      return { value: { type, base64: bytes.toString("base64") }, ttl: FAVICON_TTL };
    } catch {
      return { value: null, ttl: FAILED_TTL };
    }
  });
}
