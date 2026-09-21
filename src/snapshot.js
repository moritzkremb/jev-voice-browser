/**
 * Perception: turn the controlled page into a compact, Jev-friendly state.
 *
 *  - `collectElementsInPage` runs INSIDE the page (Playwright page.evaluate). It tags every
 *    interactive element with a stable `data-vb-id` (e01, e02, ...) and returns raw records.
 *  - `compactElements` runs in Node: prioritises viewport-visible elements, dedupes, truncates
 *    text and guards the total state size so it stays far below Jev's 32k-token limit.
 */
import { MAX_ELEMENTS, MAX_ELEMENT_TEXT, MAX_STATE_CHARS } from "./constants.js";

/** Runs in the browser. Must be self-contained (no closures). */
export function collectElementsInPage() {
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=searchbox]",
    "[role=combobox]",
    "[role=textbox]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  const win = window;
  const doc = document;
  if (!win.__vbNextId) win.__vbNextId = 1;

  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const out = [];
  const nodes = doc.querySelectorAll(SELECTOR);

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  for (const el of nodes) {
    if (out.length >= 400) break;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    const style = win.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;

    let id = el.getAttribute("data-vb-id");
    if (!id) {
      id = "e" + String(win.__vbNextId++).padStart(2, "0");
      el.setAttribute("data-vb-id", id);
    }

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    let role = el.getAttribute("role") || "";
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button" || type === "submit" || type === "button" || type === "reset") role = "button";
      else if (tag === "select") role = "select";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "summary") role = "button";
      else if (tag === "input") {
        if (type === "search") role = "searchbox";
        else if (type === "checkbox") role = "checkbox";
        else if (type === "radio") role = "radio";
        else role = "textbox";
      } else if (el.isContentEditable) role = "textbox";
      else role = "clickable";
    }

    // A field's current value is a useful label ("jev typesafe" in a search box), but not when
    // the field holds a secret: that value would travel to the API as this element's name.
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const isSecretField =
      type === "password" ||
      /(^|[\s-])(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/.test(autocomplete);

    const img = el.querySelector && el.querySelector("img[alt]");
    const name =
      clean(el.getAttribute("aria-label")) ||
      clean(el.innerText) ||
      (isSecretField ? "" : clean(el.value)) ||
      clean(el.getAttribute("placeholder")) ||
      clean(el.getAttribute("title")) ||
      (img && clean(img.getAttribute("alt"))) ||
      clean(el.getAttribute("name")) ||
      "";

    const placeholder = clean(el.getAttribute("placeholder"));
    let href = "";
    if (tag === "a") {
      try {
        const u = new URL(el.href, location.href);
        href = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
      } catch {
        href = "";
      }
    }

    const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    const inputName = clean(el.getAttribute("name")) || clean(el.getAttribute("id"));

    out.push({
      id,
      tag,
      role,
      text: name,
      placeholder,
      href,
      type,
      inputName,
      inViewport,
      top: Math.round(rect.top + win.scrollY),
      left: Math.round(rect.left + win.scrollX),
    });
  }

  return {
    url: location.href,
    title: doc.title,
    scrollY: win.scrollY,
    scrollHeight: doc.documentElement.scrollHeight,
    viewportHeight: vh,
    elements: out,
  };
}

/** Coarse site detection from the URL (code, not Jev). */
export function detectSite(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "generic";
  }
  if (host.endsWith("google.com") || host.endsWith("google.co.uk")) return "google";
  if (host.endsWith("duckduckgo.com")) return "duckduckgo";
  if (host.endsWith("youtube.com")) return "youtube";
  if (host.endsWith("wikipedia.org")) return "wikipedia";
  if (host.endsWith("github.com")) return "github";
  if (host.endsWith("amazon.com") || host.endsWith("amazon.de") || host.endsWith("amazon.co.uk")) return "amazon";
  if (host.endsWith("reddit.com")) return "reddit";
  if (host === "x.com" || host.endsWith("twitter.com")) return "twitter_x";
  if (host.endsWith("news.ycombinator.com")) return "hacker_news";
  if (host === "example.com") return "example_com";
  if (!host || url.startsWith("about:")) return "blank";
  return "generic";
}

const SEARCHY = /(^|[^a-z])(q|query|search|s|keyword|k|search_query)($|[^a-z])/i;

/** Heuristic: which element id is the page's main search box? */
export function findSearchBox(elements) {
  const inputs = elements.filter((e) => ["searchbox", "textbox", "combobox"].includes(e.role));
  const scored = inputs.map((e) => {
    let s = 0;
    if (e.role === "searchbox" || e.type === "search") s += 5;
    if (SEARCHY.test(e.inputName || "")) s += 3;
    if (/search/i.test(e.placeholder || "") || /search/i.test(e.text || "")) s += 3;
    if (e.inViewport) s += 1;
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s || a.e.top - b.e.top);
  return scored.length && scored[0].s > 0 ? scored[0].e.id : null;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/**
 * Build the compact element list that goes into the Jev state.
 * Priority: viewport-visible first (top-to-bottom), then the rest. Dedupe on (role, text, href).
 * Drops nameless elements unless they are inputs. Enforces MAX_ELEMENTS and MAX_STATE_CHARS.
 */
export function compactElements(rawElements, opts = {}) {
  const maxElements = opts.maxElements ?? MAX_ELEMENTS;
  const maxText = opts.maxText ?? MAX_ELEMENT_TEXT;
  const maxChars = opts.maxChars ?? MAX_STATE_CHARS;

  const sorted = [...rawElements].sort((a, b) => {
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    return a.top - b.top || a.left - b.left;
  });

  const seen = new Set();
  const out = [];
  for (const e of sorted) {
    const isInput = ["textbox", "searchbox", "combobox", "select", "checkbox", "radio"].includes(e.role);
    const text = truncate(e.text || e.placeholder, maxText);
    if (!text && !isInput) continue;
    const key = `${e.role}|${text.toLowerCase()}|${e.href || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { id: e.id, role: e.role, text };
    if (e.placeholder && e.placeholder !== text) rec.placeholder = truncate(e.placeholder, 40);
    if (e.href) rec.href = truncate(e.href, 50);
    if (!e.inViewport) rec.below_fold = true;
    out.push(rec);
    if (out.length >= maxElements) break;
  }

  // Size guard: shrink until the serialized list fits the budget.
  while (out.length > 5 && JSON.stringify(out).length > maxChars) {
    out.length = Math.max(5, Math.floor(out.length * 0.8));
  }
  return out;
}

/** Full snapshot record used by the controller: raw (for execution) + compact (for Jev). */
export function buildSnapshot(pageData, extra = {}) {
  const elements = compactElements(pageData.elements);
  const searchBoxId = findSearchBox(pageData.elements);
  const site = detectSite(pageData.url);
  return {
    url: pageData.url,
    title: pageData.title,
    site,
    scrollY: pageData.scrollY,
    scrollHeight: pageData.scrollHeight,
    viewportHeight: pageData.viewportHeight,
    searchBoxId,
    elements,
    rawById: Object.fromEntries(pageData.elements.map((e) => [e.id, e])),
    ...extra,
  };
}

/** Approximate token count for observability (~4 chars/token English). */
export function approxTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}
