// Link previews: links in chat messages get the site's favicon in front, a
// raw URL gets a short label ("owner/repo#168"), and hovering one opens a card
// with the page's title, or a GitHub PR's state and lines changed. bb has no
// hook for links inside message Markdown, so a content script decorates the
// links bb already rendered. The href, and so clicking, stays bb's own.
//
// React owns these anchors and may rewrite their children (setting
// textContent drops the favicon), so every pass re-applies the decoration
// idempotently rather than marking links done once.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { isRawUrl, shortLabel } from "./link-label";
import type { LinkPreview } from "./link-preview-source";
import "./link-previews.css";

const LINKS = '[data-message-column] [data-markdown-preview] a[href^="https://"]:not([data-prompt-mention])';
const DECORATED = "data-bbb-link";
const CACHE_KEY = "beautiful-bb:link-previews";
const SCAN_DELAY_MS = 150;
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 120;
const SHORT_LINK = 40;

type Decoration = { icon: HTMLImageElement; label: string | null; original: string | null; titled: boolean };

let base: string | null = null;
let enabled = localStorage.getItem(CACHE_KEY) !== "off";
let stop: (() => void) | null = null;

/** Called with the user's setting whenever it is read or changed. */
export function setLinkPreviews(on: boolean) {
  localStorage.setItem(CACHE_KEY, on ? "on" : "off");
  enabled = on;
  sync();
}

export function mountLinkPreviews(context: PluginContentScriptContext): () => void {
  base = `/api/v1/plugins/${encodeURIComponent(context.pluginId)}/http`;
  sync();
  return () => {
    base = null;
    sync();
  };
}

function sync() {
  if (base && enabled && !stop) stop = start(base);
  else if (!(base && enabled) && stop) {
    stop();
    stop = null;
  }
}

function start(base: string): () => void {
  const decorations = new WeakMap<HTMLAnchorElement, Decoration>();
  const previews = new Map<string, Promise<LinkPreview | null>>();

  const faviconUrl = (url: URL) => `${base}/favicon?domain=${encodeURIComponent(url.hostname.toLowerCase())}`;

  function icon(url: URL, className: string) {
    const img = document.createElement("img");
    img.className = className;
    img.src = faviconUrl(url);
    img.alt = "";
    img.width = 16;
    img.height = 16;
    img.decoding = "async";
    img.setAttribute("aria-hidden", "true");
    img.addEventListener("error", () => (img.hidden = true), { once: true });
    return img;
  }

  function decorate(a: HTMLAnchorElement) {
    if (a.closest("pre") || a.querySelector("img:not(.bbb-link-icon)")) return;
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      return;
    }
    let d = decorations.get(a);
    if (!d) {
      d = { icon: icon(url, "bbb-link-icon"), label: null, original: null, titled: false };
      decorations.set(a, d);
      a.setAttribute(DECORATED, "");
      if (!a.title) {
        a.title = a.href;
        d.titled = true;
      }
    }
    if (a.firstChild !== d.icon) a.prepend(d.icon);
    relabel(a, d, url);
    keepWhole(a);
  }

  function relabel(a: HTMLAnchorElement, d: Decoration, url: URL) {
    const text = d.icon.nextSibling;
    if (text?.nodeType !== Node.TEXT_NODE || text.nextSibling) return;
    const value = text.nodeValue ?? "";
    if (value === d.label || !isRawUrl(value, a.href)) return;
    d.original = value;
    d.label = shortLabel(url);
    text.nodeValue = d.label;
  }

  /** Short links stay on one line, so the icon never ends a line apart from its label. */
  function keepWhole(a: HTMLAnchorElement) {
    const short = (a.textContent ?? "").length <= SHORT_LINK;
    if (a.hasAttribute("data-bbb-link-short") !== short) a.toggleAttribute("data-bbb-link-short", short);
  }

  function undecorate(a: HTMLAnchorElement) {
    const d = decorations.get(a);
    a.removeAttribute(DECORATED);
    a.removeAttribute("data-bbb-link-short");
    if (!d) return;
    const text = d.icon.nextSibling;
    d.icon.remove();
    if (d.label !== null && text?.nodeType === Node.TEXT_NODE && text.nodeValue === d.label) text.nodeValue = d.original;
    if (d.titled) a.removeAttribute("title");
  }

  // Writes only: no layout reads, so a pass never forces a reflow.
  let scanTimer = 0;
  const scan = () => {
    scanTimer = 0;
    document.querySelectorAll<HTMLAnchorElement>(LINKS).forEach(decorate);
  };
  const observer = new MutationObserver(() => {
    scanTimer ||= window.setTimeout(scan, SCAN_DELAY_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  function preview(href: string) {
    let pending = previews.get(href);
    if (!pending) {
      pending = fetch(`${base}/link-preview?url=${encodeURIComponent(href)}`)
        .then((res) => (res.ok ? (res.json() as Promise<LinkPreview | null>) : null))
        .catch(() => null);
      previews.set(href, pending);
    }
    return pending;
  }

  const card = document.createElement("div");
  card.className = "bbb-link-card";
  card.setAttribute("role", "tooltip");
  let anchor: HTMLAnchorElement | null = null;
  let openTimer = 0;
  let closeTimer = 0;

  function el(tag: string, className: string, text?: string | null) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function fill(url: URL, data: LinkPreview) {
    const head = el("div", "bbb-link-card-head");
    head.append(icon(url, "bbb-link-card-icon"), el("span", "bbb-link-card-domain", data.kind === "github" ? data.ref : data.domain));
    const body: Node[] = [head, el("div", "bbb-link-card-title", data.title)];
    if (data.description) body.push(el("div", "bbb-link-card-desc", data.description));
    if (data.kind === "github" && (data.state || data.additions !== null)) {
      const meta = el("div", "bbb-link-card-meta");
      if (data.state) {
        const state = el("span", "bbb-link-card-state", data.state);
        state.dataset.state = data.state;
        meta.append(state);
      }
      if (data.additions !== null && data.deletions !== null) {
        meta.append(el("span", "bbb-link-card-add", `+${data.additions}`), el("span", "bbb-link-card-del", `−${data.deletions}`));
      }
      body.push(meta);
    }
    card.replaceChildren(...body);
  }

  function place(a: HTMLAnchorElement) {
    const rect = a.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = card;
    const below = rect.bottom + 6 + h <= window.innerHeight - 8;
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    card.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - h)}px`;
  }

  async function open(a: HTMLAnchorElement) {
    const data = await preview(a.href);
    if (anchor !== a || !data) return;
    fill(new URL(a.href), data);
    card.removeAttribute("data-open");
    document.body.append(card);
    place(a);
    requestAnimationFrame(() => anchor === a && card.setAttribute("data-open", ""));
  }

  function close() {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    anchor = null;
    card.remove();
  }

  const onOver = (event: PointerEvent) => {
    const target = event.target as Element;
    if (card.contains(target)) return window.clearTimeout(closeTimer);
    const a = target.closest?.<HTMLAnchorElement>(`a[${DECORATED}]`);
    if (!a || a === anchor) return void (a && window.clearTimeout(closeTimer));
    close();
    anchor = a;
    openTimer = window.setTimeout(() => void open(a), OPEN_DELAY_MS);
  };
  const onOut = (event: PointerEvent) => {
    if (!anchor) return;
    const to = event.relatedTarget as Node | null;
    if (to && (anchor.contains(to) || card.contains(to))) return;
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(close, CLOSE_DELAY_MS);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && anchor) close();
  };
  document.addEventListener("pointerover", onOver);
  document.addEventListener("pointerout", onOut);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", close, { capture: true, passive: true });

  return () => {
    observer.disconnect();
    window.clearTimeout(scanTimer);
    close();
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", close, { capture: true });
    document.querySelectorAll<HTMLAnchorElement>(`a[${DECORATED}]`).forEach(undecorate);
  };
}
