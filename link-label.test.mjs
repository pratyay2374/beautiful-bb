import assert from "node:assert/strict";
import test from "node:test";
import { isRawUrl, shortLabel } from "./link-label.ts";

test("raw URLs get a short label", () => {
  const cases = {
    "https://github.com/owner/repo/pull/168": "owner/repo#168",
    "https://github.com/owner/repo/issues/9": "owner/repo#9",
    "https://github.com/owner/repo/commit/7db553e1a2b3c4d5": "owner/repo@7db553e",
    "https://github.com/owner/repo": "owner/repo",
    "https://www.example.com/": "example.com",
    "https://getbb.app/plugin-guide": "getbb.app/plugin-guide",
    "https://docs.example.com/a/very/long/path/that/keeps/going": "docs.example.com/a/very/long/path/that/keep…",
  };
  for (const [href, label] of Object.entries(cases)) assert.equal(shortLabel(new URL(href)), label, href);
});

test("only a link whose text is its URL counts as raw", () => {
  assert.ok(isRawUrl("https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1"));
  assert.ok(isRawUrl("example.com/a", "https://example.com/a/"));
  assert.ok(!isRawUrl("PR #1", "https://github.com/o/r/pull/1"));
});
