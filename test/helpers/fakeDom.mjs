/**
 * Minimal stand-in for the `createEl`/`createDiv`/`createSpan` helpers that
 * Obsidian's Electron runtime adds to `HTMLElement.prototype`. Only the
 * subset that src/KStepCard.ts actually calls is implemented — enough to
 * unit-test its render* functions headlessly, without a real DOM (jsdom or
 * otherwise) as a dependency.
 */
export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
  }

  createEl(tag, opts = {}) {
    const el = new FakeElement(tag);
    if (opts.cls) el.className = opts.cls;
    if (opts.text !== undefined) el.textContent = opts.text;
    this.children.push(el);
    return el;
  }

  createDiv(opts) {
    return this.createEl("div", opts);
  }

  createSpan(opts) {
    return this.createEl("span", opts);
  }

  /**
   * Only used by src/KStepCard.ts's `renderGeometry`, which appends the
   * parsed SVG root (a `FakeDomNode`, see below) into a `createDiv`-made
   * plate. Not tracked as a distinct "real" child type — `FakeDomNode`
   * implements the same `tagName`/`children`/`queryAll`/`queryAllByClass`/
   * `allText` shape as `FakeElement`, so traversal from a `FakeElement` root
   * into an appended `FakeDomNode` subtree works transparently.
   */
  appendChild(node) {
    this.children.push(node);
    return node;
  }

  /** All descendants (depth-first) with the given tag name. */
  queryAll(tag) {
    const out = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.queryAll(tag));
    }
    return out;
  }

  /** All descendants (depth-first) whose className contains the given class. */
  queryAllByClass(cls) {
    const out = [];
    for (const c of this.children) {
      if (c.className.split(/\s+/).includes(cls)) out.push(c);
      out.push(...c.queryAllByClass(cls));
    }
    return out;
  }

  /** Every non-empty textContent in this subtree, joined with spaces. */
  allText() {
    const parts = this.textContent ? [this.textContent] : [];
    for (const c of this.children) {
      const t = c.allText();
      if (t) parts.push(t);
    }
    return parts.join(" ");
  }
}

/**
 * Minimal stand-in for a browser DOM node, used only as the result of
 * `FakeDOMParser.parseFromString` below — enough for src/KStepCard.ts's
 * `renderGeometry` to run headlessly against it: `querySelector`/
 * `querySelectorAll` (used to find `parsererror` and to strip
 * `script`/`foreignObject`), `remove()` (used by that stripping),
 * `getAttribute`/`setAttribute`/`removeAttribute` (used to read/clear
 * `width`/`height`), and `documentElement`.
 *
 * Deliberately mirrors `FakeElement`'s `tagName`/`children`/`queryAll`/
 * `queryAllByClass`/`allText`/`appendChild` shape (rather than only
 * DOM-style methods) so a test can traverse from a `FakeElement` container,
 * through an `appendChild`-ed `FakeDomNode` subtree (see `renderGeometry`:
 * `plate.appendChild(svgEl)`), with the same handful of helper methods
 * throughout — no branching in test code on which fake it is looking at.
 */
/**
 * Namespace URI a fake `xlink:`-prefixed attribute name resolves to. Real
 * `DOMParser` resolves this from the document's own `xmlns:xlink="..."`
 * declaration, which this toy XML parser (see `parseXml` below) never reads
 * — every kstep-cli SVG fixture that uses the prefix uses exactly this URI,
 * so a fixed mapping is sufficient here.
 */
const FAKE_XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * Namespace every element in these test fixtures is assumed to start in
 * when it doesn't declare its own `xmlns`. Diverges from a real `DOMParser`
 * (verified via jsdom: an `<svg>` root parsed as `image/svg+xml` with no
 * `xmlns` attribute gets `namespaceURI === null`, not the SVG namespace) —
 * done deliberately so the many existing fixtures in this file that write
 * `<svg width="10" height="10">` without bothering to declare `xmlns` don't
 * all need editing. This gap between the toy default and the real default
 * never manifests against a real payload: `kstep-cli`'s SVG writer
 * (`TriangleSvgWriter.kt`) always emits `xmlns="http://www.w3.org/2000/svg"`
 * on the root explicitly, so every actual fixture that matters here — and
 * every test that wants to exercise a *foreign*-namespaced element — sets
 * `xmlns` explicitly and that explicit value wins, exactly as it does in a
 * real DOM.
 */
const ASSUMED_SVG_NS = "http://www.w3.org/2000/svg";

export class FakeDomNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.namespaceURI = null;
  }

  get className() {
    return this.attrs.class ?? "";
  }

  /**
   * Mirrors a real `Document.documentElement`: a *live* getter derived from
   * the current children, not a value snapshotted once at parse time. This
   * matters for `#document` nodes specifically — `FakeDOMParser` below never
   * has more than one top-level child (the parsed root, or a `parsererror`
   * node on malformed input), so "the current first child" and "the
   * document's root element" coincide here exactly as they do in a real DOM.
   * Getting this right is what lets a test reproduce the real-DOM behaviour
   * `src/KStepCard.ts`'s `renderGeometry` must defend against: if
   * `sanitizeSvgDoc`'s `querySelectorAll(...).forEach(n => n.remove())`
   * removes the root element itself (its tag matched the removal list),
   * `documentElement` must become `null` afterwards — a plain assigned
   * property, set once in `parseFromString`, would keep pointing at the
   * now-detached node and silently fail to reproduce that.
   */
  get documentElement() {
    return this.children.length > 0 ? this.children[0] : null;
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  removeAttribute(name) {
    delete this.attrs[name];
  }

  /**
   * Stand-in for a real `Element.attributes` (`NamedNodeMap`), just enough
   * for `src/KStepCard.ts`'s sanitiser to iterate: an array of
   * `{name, value, localName, namespaceURI}`. Splits an `xlink:`-prefixed
   * name the same way a real namespace-aware `DOMParser` would resolve it
   * (see `FAKE_XLINK_NS` above) — every other attribute is treated as
   * unprefixed/no-namespace, which is all real kstep-cli SVG output ever
   * uses beyond that one prefix.
   */
  get attributes() {
    return Object.entries(this.attrs).map(([name, value]) => {
      const colon = name.indexOf(":");
      if (colon !== -1 && name.slice(0, colon) === "xlink") {
        return { name, value, localName: name.slice(colon + 1), namespaceURI: FAKE_XLINK_NS };
      }
      return { name, value, localName: name, namespaceURI: null };
    });
  }

  /** Stand-in for `Element.removeAttributeNS` — resolves back to the prefixed key by the same mapping `attributes` above uses. */
  removeAttributeNS(namespaceURI, localName) {
    for (const name of Object.keys(this.attrs)) {
      const colon = name.indexOf(":");
      const attrLocalName = colon !== -1 ? name.slice(colon + 1) : name;
      const attrNs = colon !== -1 && name.slice(0, colon) === "xlink" ? FAKE_XLINK_NS : null;
      if (attrLocalName === localName && attrNs === namespaceURI) {
        delete this.attrs[name];
        return;
      }
    }
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  /** Detaches this node from its parent's `children` — mirrors `Element.remove()`. */
  remove() {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx !== -1) this.parent.children.splice(idx, 1);
    this.parent = null;
  }

  /**
   * Supports the two selector shapes `src/KStepCard.ts`'s sanitiser uses:
   * `"*"` (every descendant element) and a comma-separated list of tag names
   * (e.g. "script, foreignObject, style, animate, ..."). Not a general CSS
   * selector engine.
   */
  querySelectorAll(selector) {
    if (selector.trim() === "*") {
      const all = [];
      const walkAll = (node) => {
        for (const c of node.children) {
          all.push(c);
          walkAll(c);
        }
      };
      walkAll(this);
      return all;
    }
    const tags = selector.split(",").map((s) => s.trim());
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (tags.includes(c.tagName)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** All descendants (depth-first) with the given tag name — mirrors FakeElement.queryAll. */
  queryAll(tag) {
    const out = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.queryAll(tag));
    }
    return out;
  }

  /** All descendants (depth-first) whose className contains the given class — mirrors FakeElement.queryAllByClass. */
  queryAllByClass(cls) {
    const out = [];
    for (const c of this.children) {
      if (c.className.split(/\s+/).includes(cls)) out.push(c);
      out.push(...c.queryAllByClass(cls));
    }
    return out;
  }

  /** Every non-empty textContent in this subtree, joined with spaces — mirrors FakeElement.allText. */
  allText() {
    const parts = this.textContent ? [this.textContent] : [];
    for (const c of this.children) {
      const t = c.allText();
      if (t) parts.push(t);
    }
    return parts.join(" ");
  }
}

class XmlParseError extends Error {}

/**
 * A small recursive-descent XML parser — just enough to parse the simple,
 * well-formed SVG fixtures used in tests (tags, attributes, self-closing
 * tags, nesting, text content) and to reliably THROW on malformed input
 * (mismatched/missing closing tags, unterminated attributes), which is what
 * `FakeDOMParser` below needs to reproduce a real `DOMParser`'s
 * `parsererror` behaviour. Not a general-purpose/spec-compliant XML parser —
 * no entity decoding, namespaces, comments, or CDATA — real kstep-cli SVG
 * output does not use any of those.
 */
function parseXml(str) {
  let i = 0;
  const n = str.length;

  const isWhitespace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

  function skipWhitespace() {
    while (i < n && isWhitespace(str[i])) i++;
  }

  function parseName() {
    const start = i;
    while (i < n && !isWhitespace(str[i]) && str[i] !== "/" && str[i] !== ">" && str[i] !== "=") i++;
    if (i === start) throw new XmlParseError(`Expected a tag/attribute name at position ${i}`);
    return str.slice(start, i);
  }

  function parseAttributes(node) {
    while (true) {
      skipWhitespace();
      if (i >= n) throw new XmlParseError("Unexpected end of input while parsing attributes");
      if (str[i] === "/" || str[i] === ">") return;
      const name = parseName();
      skipWhitespace();
      if (str[i] !== "=") throw new XmlParseError(`Expected '=' after attribute name '${name}'`);
      i++;
      skipWhitespace();
      const quote = str[i];
      if (quote !== '"' && quote !== "'") throw new XmlParseError("Expected a quoted attribute value");
      i++;
      const start = i;
      while (i < n && str[i] !== quote) i++;
      if (i >= n) throw new XmlParseError("Unterminated attribute value");
      node.setAttribute(name, str.slice(start, i));
      i++;
    }
  }

  /**
   * `inheritedNs` is the namespace this element defaults to when it doesn't
   * declare its own `xmlns` — the document-assumed SVG namespace for the
   * root call below, or the parent's resolved namespace for every recursive
   * call, mirroring real XML namespace inheritance (an explicit `xmlns` on
   * an element always overrides what it inherited).
   */
  function parseElement(inheritedNs) {
    if (str[i] !== "<") throw new XmlParseError(`Expected '<' at position ${i}`);
    i++;
    const name = parseName();
    const node = new FakeDomNode(name);
    parseAttributes(node);
    node.namespaceURI = Object.prototype.hasOwnProperty.call(node.attrs, "xmlns") ? node.attrs.xmlns : inheritedNs;

    if (str[i] === "/") {
      i++;
      if (str[i] !== ">") throw new XmlParseError("Malformed self-closing tag");
      i++;
      return node;
    }
    if (str[i] !== ">") throw new XmlParseError(`Expected '>' at position ${i}`);
    i++;

    while (true) {
      if (i >= n) throw new XmlParseError(`Unclosed tag <${name}>`);
      if (str[i] === "<") {
        if (str[i + 1] === "/") {
          const closeStart = i + 2;
          let j = closeStart;
          while (j < n && str[j] !== ">") j++;
          if (j >= n) throw new XmlParseError(`Unterminated closing tag for <${name}>`);
          const closeName = str.slice(closeStart, j).trim();
          if (closeName !== name) {
            throw new XmlParseError(`Mismatched closing tag: expected </${name}>, found </${closeName}>`);
          }
          i = j + 1;
          return node;
        }
        node.appendChild(parseElement(node.namespaceURI));
      } else {
        const start = i;
        while (i < n && str[i] !== "<") i++;
        node.textContent += str.slice(start, i);
      }
    }
  }

  skipWhitespace();
  const root = parseElement(ASSUMED_SVG_NS);
  return root;
}

/**
 * Minimal stand-in for the browser's global `DOMParser`, used only by
 * src/KStepCard.ts's `renderGeometry` (`new DOMParser()` — a real browser
 * global in Obsidian's Electron runtime, but absent in plain Node, where
 * these tests run). A test that needs `renderGeometry` must set
 * `globalThis.DOMParser = FakeDOMParser` before calling it — see
 * test/kstep-card.test.mjs.
 */
export class FakeDOMParser {
  parseFromString(source) {
    const doc = new FakeDomNode("#document");
    try {
      const root = parseXml(source);
      doc.appendChild(root);
      // `documentElement` is a live getter on FakeDomNode (see above) that
      // reads back `doc.children[0]` — appending is sufficient, no separate
      // assignment needed (and none is possible: the getter has no setter).
    } catch (e) {
      // Mirrors a real DOMParser: on malformed input, the returned document's
      // `documentElement` becomes a `parsererror` node instead of throwing.
      const err = new FakeDomNode("parsererror");
      err.textContent = e instanceof Error ? e.message : String(e);
      doc.appendChild(err);
    }
    return doc;
  }
}
