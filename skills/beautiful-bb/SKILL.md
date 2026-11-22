---
name: beautiful-bb
description: Switch to or edit the Beautiful bb plugin's themes, such as T3 Night.
---

# Beautiful bb

The plugin contributes app themes through `bb.themes` in its `package.json`.

- Activate T3 Night: `bb theme set plugin:beautiful-bb:t3-night`
- Back to the default: `bb theme reset`
- List themes: `bb theme list`

## Editing a theme

Edit `themes/<name>.src.css`, never the generated `themes/<name>.css`. Then run
`node scripts/build-themes.mjs` to write it and
`bb plugin reload beautiful-bb` to apply. The build fails if a theme exceeds
bb's 256 KB stylesheet limit.

Token reference: the bb-cli skill's `references/theming.md`.

## Link previews

The "Link previews" setting (on by default) puts a favicon before each link in
chat messages, shortens raw URLs (`owner/repo#168`), and shows a hover card.
The plugin server fetches favicons and page titles (https only, no cookies) and
caches them in plugin KV: favicons for a week, pages for a day, GitHub for an
hour. GitHub PRs, issues and commits are read through `gh api`, PRs from
`~/.cache/bb-prs/open-prs.json` first. Routes:
`/api/v1/plugins/beautiful-bb/http/favicon?domain=` and `/link-preview?url=`.
