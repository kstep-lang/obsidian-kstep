import type { KStepErrorJson, KStepSuccessJson } from "./KStepResult";
import { blockOffersViewer, hasWebGl2 } from "./KStepGlb";

/**
 * No `obsidian` import here — `createEl`/`createDiv` are available because
 * they are added to the global `HTMLElement` interface by the `obsidian`
 * package's ambient type declarations, which are already part of this
 * program (main.ts imports from "obsidian"). Only DOM/TypeScript-lib types
 * are used directly in this file.
 */

export interface TextSection {
  heading: string;
  body: string[];
}

/**
 * Splits a kstep-cli text preview into sections.
 *
 * Rules (derived from real CLI output — see the implementation report):
 *  - The first non-empty line, if it starts with "kSTEP preview --", is the
 *    file-name banner and is dropped.
 *  - A non-empty, non-indented line starts a new section (its heading).
 *  - An indented line is appended (trimmed) to the current section's body.
 *  - Blank lines are ignored.
 *
 * If fewer than two sections come out of this, the caller should fall back
 * to showing the raw text verbatim — a card must never end up empty.
 */
export function parseCardText(text: string): TextSection[] {
  const lines = text.split("\n");

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start < lines.length && /^kSTEP preview --/.test(lines[start])) {
    start++;
  }

  const sections: TextSection[] = [];
  let current: TextSection | null = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const isIndented = /^\s/.test(line);
    if (!isIndented) {
      current = { heading: line.trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line.trim());
    } else {
      // Indented line before any heading was seen — keep it rather than
      // drop it silently.
      current = { heading: "", body: [line.trim()] };
      sections.push(current);
    }
  }

  return sections;
}

function renderSections(card: HTMLElement, text: string): void {
  const sections = parseCardText(text);
  if (sections.length < 2) {
    // Parser didn't find a recognisable structure — never show an empty card.
    card.createEl("pre", { text });
    return;
  }
  for (const section of sections) {
    if (section.heading) {
      card.createDiv({ cls: "kstep-card-heading", text: section.heading });
    }
    const body = card.createDiv({ cls: "kstep-card-body" });
    for (const line of section.body) {
      body.createDiv({ text: line });
    }
  }
}

const XLINK_NS = "http://www.w3.org/1999/xlink";
const SVG_NS = "http://www.w3.org/2000/svg";

// Matches a CSS function token — e.g. the `translate(` in
// `transform="translate(10,20)"` or the `url(` in `fill="url(#x)"` — used
// below to gate presentation attributes (`fill`, `stroke`, `filter`,
// `clip-path`, `mask`, `cursor`, `transform`, …) against every CSS function
// that can trigger a real fetch, not just `url(...)`. `image-set(...)` and
// `-webkit-image-set(...)` resolve to the same kind of external request as
// `url(...)` when the browser computes styles from the attribute — a
// `cursor="image-set(\"https://evil.example/beacon.png\" 1x), auto"` fires
// exactly like `filter="url(https://evil.example/f.svg#f)"` does, without
// ever containing the substring `url(`. A blocklist keyed on that one
// function name (or any other single name) only ever covers what's already
// been found — the CSS image-function surface is open-ended (`src()`,
// `image()`, `cross-fade()`, and whatever the spec adds next). So the gate
// below is an allowlist instead: an attribute value that contains ANY CSS
// function token is kept only if every function name in it is one legitimate
// SVG presentation values actually use, with `url(...)` additionally
// required to be a same-document fragment reference (`url(#id)`). Anything
// else — an unlisted function name, or a non-fragment `url(...)` — drops the
// whole attribute. Mirrors the sibling obsidian-ktriz plugin's
// KtrizDomRenderer.ts, which documents the same reasoning in full.
const CSS_FUNCTION_TOKEN_RE = /([a-zA-Z-]+)\s*\(/g;
const URL_FUNCTION_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const ALLOWED_CSS_FUNCTIONS = new Set([
  "url",
  "translate",
  "translatex",
  "translatey",
  "rotate",
  "scale",
  "scalex",
  "scaley",
  "matrix",
  "skewx",
  "skewy",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
]);

/**
 * `true` when `value` is safe to keep as-is: either it contains no CSS
 * function token at all, or every function token in it names an allowlisted
 * function and every `url(...)` among them is a same-document fragment
 * reference. `false` means the caller should drop the whole attribute —
 * never partially rewritten.
 */
function attributeValueUsesOnlyAllowedCssFunctions(value: string): boolean {
  CSS_FUNCTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let sawFunction = false;
  while ((match = CSS_FUNCTION_TOKEN_RE.exec(value)) !== null) {
    sawFunction = true;
    if (!ALLOWED_CSS_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  if (!sawFunction) return true;
  URL_FUNCTION_RE.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = URL_FUNCTION_RE.exec(value)) !== null) {
    if (!urlMatch[2].trim().startsWith("#")) return false;
  }
  return true;
}

/**
 * Sanitises a parsed SVG document in place before it is ever appended to the
 * DOM — the SVG text is the stdout of an arbitrary user Kotlin script piped
 * through kstep-cli, not just the output of kSTEP's own renderer, so this is
 * treated the same as any other untrusted HTML/SVG string. Ported from the
 * sibling obsidian-ktriz plugin's `injectSvg` (KtrizDomRenderer.ts), which
 * documents each of the choices below in full — kept here rather than a
 * shared package because neither plugin has a shared-code mechanism yet.
 *
 * Removes, as whole elements: `<script>`/`<foreignObject>` (as before), plus
 * `<style>` (parsing CSS correctly, including `@import`/`url()` in nested
 * selectors, is its own project, and a stylesheet is never load-bearing for
 * a kSTEP geometry preview) and the SMIL animation elements
 * `<animate>`/`<animateTransform>`/`<animateMotion>`/`<set>`/`<discard>` —
 * these are a script-free way to re-apply an attribute the loop below
 * strips, e.g. `<image href="#x"><set attributeName="href"
 * to="https://evil.example/beacon.png" begin="0s"/></image>` sets `href`
 * back to a blocked external URL purely through animation timing.
 *
 * Before any attribute is examined, every element that is not in the SVG
 * namespace is removed outright. The tag-name removal list above is a
 * blocklist — it only ever covers what's already been found, the same
 * limitation the doc comment on `ALLOWED_CSS_FUNCTIONS` above calls out for
 * CSS functions. A foreign-namespaced element sidesteps it completely: an
 * XHTML `<img src="https://evil.example/beacon.png">`, `<iframe src=...>`,
 * or `<object data=...>` mixed into the SVG parses as a live
 * HTMLImageElement/HTMLIFrameElement/HTMLObjectElement (verified against a
 * real DOMParser), fires its request the moment it is appended to the DOM,
 * and matches none of `script, foreignObject, style, animate, ...` by tag
 * name, nor `on*`/`style`/`href` by attribute name — none of the checks
 * below ever run against it. `kstep-cli`'s own SVG writer always declares
 * `xmlns="http://www.w3.org/2000/svg"` on the root (every element inherits
 * that default namespace unless it re-declares its own, per XML namespace
 * resolution), so this drops nothing a legitimate render ever produces.
 *
 * Then, on every remaining element's every attribute: strips any `on*`
 * event-handler attribute; strips `style`, `src`, `data`, `srcdoc`,
 * `poster`, and `formaction` outright (same "never load-bearing, so drop
 * rather than half-parse" reasoning as `<style>` above — none of these are
 * meaningful SVG presentation attributes, and each is a live-request vector
 * on some element in some renderer); strips any `href`/`xlink:href`
 * (namespace-aware — the `xlink` prefix is attacker-controlled via the
 * SVG's own `xmlns:xlink` declaration) that isn't a same-document fragment
 * reference; strips any attribute value containing a backslash (a CSS
 * escape sequence like `\75 rl(` for `url(` passes straight through the
 * allowlist gate below in cleartext form, and no legitimate SVG attribute
 * value has a reason to contain one); and finally gates every remaining
 * value through `attributeValueUsesOnlyAllowedCssFunctions`.
 */
function sanitizeSvgDoc(doc: Document): void {
  doc
    .querySelectorAll("script, foreignObject, style, animate, animateTransform, animateMotion, set, discard")
    .forEach((n) => n.remove());

  doc.querySelectorAll("*").forEach((node) => {
    if (node.namespaceURI !== SVG_NS) node.remove();
  });

  doc.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === "style" || name === "src" || name === "data" || name === "srcdoc" || name === "poster" || name === "formaction") {
        node.removeAttribute(attr.name);
        continue;
      }
      const isHrefAttr =
        attr.localName.toLowerCase() === "href" &&
        (attr.namespaceURI === null || attr.namespaceURI === XLINK_NS);
      if (isHrefAttr && !attr.value.trim().startsWith("#")) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
        continue;
      }
      if (attr.value.includes("\\")) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
        continue;
      }
      if (!attributeValueUsesOnlyAllowedCssFunctions(attr.value)) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
      }
    }
  });
}

/**
 * Renders a geometry preview: the CLI's SVG, inline (DOMParser → appendChild,
 * never innerHTML), on a fixed white "plate" — a deliberate, documented
 * exception to using only Obsidian theme tokens (see styles.css).
 *
 * `onOpen3d`, when provided, is main.ts's composition-root callback for
 * mounting the (three.js-backed) 3D viewer — this module itself stays free
 * of any `three` import, matching KStepGlb.ts (see KStepViewer.ts's own
 * header comment for why that separation matters). Called with the viewer
 * host element, the poster (this function's own SVG plate), and a
 * `resetToPoster` callback every time the toggle switches INTO 3D mode;
 * toggling back to 2D via the button itself is handled entirely locally (no
 * callback, no CLI round trip — see the design report's card-toggle
 * description) — `resetToPoster` exists so main.ts's `Kstep3dController` can
 * trigger that same swap-back from OUTSIDE a click, specifically when the
 * plugin-wide viewer LRU cap (`ViewerRegistry`, KStepGlb.ts) evicts this
 * card's handle asynchronously, long after the toggle click that opened it
 * (MAJOR finding, this wave's review — without this hook a card evicted this
 * way stayed stuck on a blank, already-closed canvas with no way back to 2D
 * short of a full note re-render).
 */
export function renderGeometry(
  container: HTMLElement,
  svg: string,
  json: KStepSuccessJson,
  onOpen3d?: (host: HTMLElement, poster: HTMLElement, resetToPoster: () => void) => void,
): void {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    renderInvocationError(
      container,
      "Could not parse the rendered SVG",
      parserError.textContent ?? "Unknown parse error.",
    );
    return;
  }

  // Defence in depth: the CLI's own SVG writer emits none of what this
  // strips today (verified), but the SVG text is arbitrary user-script
  // stdout, not just the CLI's own output — see `sanitizeSvgDoc`'s doc
  // comment.
  sanitizeSvgDoc(doc);

  // sanitizeSvgDoc removes whole elements (script, style, the SMIL
  // animation tags, ...) by tag name without regard to whether one of them
  // happens to be the document's root element. If the CLI's stdout produced
  // an SVG whose root was one of those tags (e.g. a script-mangled payload
  // rooted in `<style>` or `<set>`), `doc.documentElement` is `null` per DOM
  // spec after the removal — guard instead of dereferencing unconditionally.
  const svgEl = doc.documentElement;
  if (!svgEl) {
    renderInvocationError(
      container,
      "Could not parse the rendered SVG",
      "The SVG had no usable root element after sanitisation.",
    );
    return;
  }
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");

  // A relatively-positioned wrapper, not `container` itself, so the 3D
  // toggle button (absolutely positioned "top right of the card" — see
  // styles.css's `.kstep-3d-toggle`) is placed relative to the plate rather
  // than the whole block (which may also contain the shape-count note below
  // it).
  const wrap = container.createDiv({ cls: "kstep-geometry-wrap" });
  const plate = wrap.createDiv({ cls: "kstep-plate" });
  plate.appendChild(svgEl);

  if (json.geometry.shapeCount > 1) {
    container.createDiv({
      cls: "kstep-plate-note",
      text: `Showing shape 1 of ${json.geometry.shapeCount}.`,
    });
  }

  if (onOpen3d && blockOffersViewer(json) && hasWebGl2()) {
    renderViewerToggle(wrap, plate, onOpen3d);
  }
}

/**
 * Builds the "3D"/"2D" toggle button plus the (initially hidden) viewer host
 * and its three visible controls (zoom in, zoom out, reset — Kare's "no
 * icon, a text label" rule applies only to the mode toggle itself; +/−/
 * "Zurücksetzen" are conventional enough as bare glyphs/short words).
 *
 * `host` and the three control buttons are found by main.ts's `onOpen3d`
 * implementation via their fixed classes (`.kstep-3d-zoom-in` etc.) — see
 * that function for the wiring to a mounted `Viewer3dHandle`'s
 * `zoomIn`/`zoomOut`/`resetView`. This module never imports KStepViewer.ts
 * (which would pull `three` into this file's own bundle), so it cannot wire
 * them itself.
 */
function renderViewerToggle(
  wrap: HTMLElement,
  poster: HTMLElement,
  onOpen3d: (host: HTMLElement, poster: HTMLElement, resetToPoster: () => void) => void,
): void {
  const toggle = wrap.createEl("button", { cls: "kstep-3d-toggle", text: "3D" });
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-label", "Als 3D-Modell anzeigen");

  const host = wrap.createDiv({ cls: "kstep-viewer" });
  host.hidden = true;

  const controls = wrap.createDiv({ cls: "kstep-3d-controls" });
  controls.hidden = true;
  const zoomIn = controls.createEl("button", { cls: "kstep-3d-zoom-in", text: "+" });
  zoomIn.setAttribute("type", "button");
  zoomIn.setAttribute("aria-label", "Vergrößern");
  const zoomOut = controls.createEl("button", { cls: "kstep-3d-zoom-out", text: "−" });
  zoomOut.setAttribute("type", "button");
  zoomOut.setAttribute("aria-label", "Verkleinern");
  const reset = controls.createEl("button", { cls: "kstep-3d-reset", text: "Zurücksetzen" });
  reset.setAttribute("type", "button");
  reset.setAttribute("aria-label", "Ansicht zurücksetzen");

  let opened = false;

  /**
   * Swaps the card back to its 2D poster — the button-click "back to 2D"
   * branch below, factored out so `Kstep3dController` (main.ts) can also
   * call it, unprompted by a click, when this card's handle gets evicted by
   * the plugin-wide LRU cap (see `onOpen3d`'s doc comment above). Idempotent
   * (safe to call when already in 2D): both call sites either already
   * checked `opened` first (the click handler) or don't need to (eviction
   * only ever happens while a handle — and therefore the 3D view — is
   * active).
   */
  function resetToPoster(): void {
    opened = false;
    toggle.textContent = "3D";
    toggle.setAttribute("aria-label", "Als 3D-Modell anzeigen");
    host.hidden = true;
    controls.hidden = true;
    poster.hidden = false;
  }

  toggle.addEventListener("click", () => {
    opened = !opened;
    if (opened) {
      toggle.textContent = "2D";
      toggle.setAttribute("aria-label", "Als 2D-Ansicht anzeigen");
      poster.hidden = true;
      host.hidden = false;
      controls.hidden = false;
      onOpen3d(host, poster, resetToPoster);
    } else {
      resetToPoster();
    }
  });
}

/**
 * Error card painted INSIDE the viewer host when an async GLB mount/parse
 * failure happens (`KStepViewer.ts`'s `mountViewer` `onAsyncError`) or when
 * the second (`-f glb`) CLI call itself fails after the toggle was already
 * switched to 3D. The poster/plate is left untouched — a viewer failure
 * never takes away the 2D preview the user already had.
 *
 * Clears `host` first (MINOR finding, this wave's review): `main.ts`'s
 * `Kstep3dController` re-attempts a failed open on every subsequent 3D click
 * (its own `this.handle` guard only ever prevents re-entry once a mount has
 * actually *succeeded*), and without this every retry stacked another error
 * box under the previous one rather than replacing it — invisible ones piling
 * up below the fold of the fixed-aspect-ratio viewer host (`.kstep-viewer`,
 * `overflow: hidden` in styles.css).
 */
export function renderViewerError(host: HTMLElement, title: string, detail: string): void {
  host.empty();
  const box = host.createDiv({ cls: "kstep-viewer-error" });
  box.createEl("strong", { cls: "kstep-error-title", text: title });
  box.createEl("pre", { text: detail });
}

/** Neutral card for a model that has no geometry — a correct state, not a warning. */
export function renderSummary(container: HTMLElement, text: string): void {
  const card = container.createDiv({ cls: "kstep-card" });
  card.createDiv({
    cls: "kstep-card-note",
    text: "Product structure only — this model contains no geometry.",
  });
  renderSections(card, text);
}

const NOTICE_MESSAGES: Record<string, string> = {
  occt_unavailable: "OCCT is not available on this machine — showing a text preview instead.",
  shape_closed_by_script:
    "The script closed the shape before it could be rendered — remove the `use { }` block around the shape.",
  triangulation_failed: "The geometry could not be triangulated.",
};

/** Card for a geometry-bearing model that fell back to a text preview this run. */
export function renderNotice(container: HTMLElement, text: string, json: KStepSuccessJson): void {
  const card = container.createDiv({ cls: "kstep-card" });
  const reason = json.fallbackReason;
  const message =
    (reason !== undefined ? NOTICE_MESSAGES[reason] : undefined) ??
    reason ??
    "Geometry preview unavailable this run.";
  card.createDiv({ cls: "kstep-card-warning", text: message });
  renderSections(card, text);
}

/** Card for a structured CLI error (compilation, validation, runtime, I/O). */
export function renderCliError(container: HTMLElement, json: KStepErrorJson): void {
  const box = container.createDiv({ cls: "kstep-error" });
  box.createEl("strong", { cls: "kstep-error-title", text: "kSTEP render error" });
  const list = box.createEl("ul", { cls: "kstep-diag-list" });

  switch (json.errorKind) {
    case "compilation_error":
      for (const d of json.diagnostics) {
        const prefix = d.line !== null ? `${d.line}:${d.column ?? "?"} — ` : "";
        list.createEl("li", { text: `${prefix}${d.message}` });
      }
      break;
    case "validation_failed":
      for (const v of json.violations) {
        list.createEl("li", { text: `[${v.code}] ${v.entityName}: ${v.message}` });
      }
      break;
    case "runtime_error":
      list.createEl("li", { text: `${json.message} (${json.exceptionClass})` });
      break;
    case "no_model_produced":
    case "io_error":
      list.createEl("li", { text: json.message });
      break;
    case "geometry_unavailable":
      list.createEl("li", { text: json.fallbackReason });
      break;
  }
}

/** Card for a failure to invoke the CLI at all (not found, timeout, crash). */
export function renderInvocationError(container: HTMLElement, title: string, detail: string): void {
  const box = container.createDiv({ cls: "kstep-error" });
  box.createEl("strong", { cls: "kstep-error-title", text: title });
  box.createEl("pre", { text: detail });
}
