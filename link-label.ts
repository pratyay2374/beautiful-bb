// What a chat link points at, read from its URL alone. Shared by the content
// script (the short label) and the server (which GitHub API to ask).

export type GithubRef = {
  repo: string;
  kind: "pr" | "issue" | "commit" | "repo";
  /** The PR or issue number, or the full commit SHA; empty for a repo. */
  id: string;
};

const GITHUB = /^\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|commit)\/(\w+))?\/?$/;

export function githubRef(url: URL): GithubRef | null {
  if (url.hostname !== "github.com") return null;
  const m = GITHUB.exec(url.pathname);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  if (!m[3]) return { repo, kind: "repo", id: "" };
  if (m[3] === "commit") return /^[0-9a-f]{7,40}$/i.test(m[4]!) ? { repo, kind: "commit", id: m[4]! } : null;
  return /^\d+$/.test(m[4]!) ? { repo, kind: m[3] === "pull" ? "pr" : "issue", id: m[4]! } : null;
}

export const domainOf = (url: URL) => url.hostname.replace(/^www\./, "");

const MAX_PATH = 28;

/** "owner/repo#168", "owner/repo@1a2b3c4", or the domain plus a short path. */
export function shortLabel(url: URL): string {
  const gh = githubRef(url);
  if (gh) {
    if (gh.kind === "repo") return gh.repo;
    return gh.kind === "commit" ? `${gh.repo}@${gh.id.slice(0, 7)}` : `${gh.repo}#${gh.id}`;
  }
  let path = url.pathname.replace(/\/+$/, "");
  try {
    path = decodeURI(path);
  } catch {
    // A malformed escape; show it as written.
  }
  if (!path) return domainOf(url);
  return domainOf(url) + (path.length > MAX_PATH ? `${path.slice(0, MAX_PATH - 1)}…` : path);
}

/** Whether a link's visible text is just its URL, so a short label loses nothing. */
export function isRawUrl(text: string, href: string): boolean {
  const bare = (s: string) => s.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return bare(text) === bare(href);
}
