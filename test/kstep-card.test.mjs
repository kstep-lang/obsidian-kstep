import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers/loadModule.mjs";
import { FakeElement, FakeDOMParser, installFakeWebGl2 } from "./helpers/fakeDom.mjs";

// src/KStepCard.ts's renderGeometry calls the browser global `new
// DOMParser()` — real in Obsidian's Electron runtime, absent in plain Node.
// Must be set before renderGeometry is called (not necessarily before this
// import — the module only references the global at call time), so setting
// it here at top level, ahead of every test in this file, is sufficient.
globalThis.DOMParser = FakeDOMParser;

const {
  parseCardText,
  renderGeometry,
  renderCliError,
  renderSummary,
  renderNotice,
  renderInvocationError,
  renderViewerError,
} = await loadModule("src/KStepCard.ts");

// ── parseCardText ────────────────────────────────────────────────────────

test("parseCardText: drops the 'kSTEP preview --' banner line", () => {
  const text = ["kSTEP preview -- hello.kstep.kts", "Model", "    name: Widget"].join("\n");
  const sections = parseCardText(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "Model");
  assert.deepEqual(sections[0].body, ["name: Widget"]);
});

test("parseCardText: groups indented lines under the preceding heading, ignores blank lines", () => {
  const text = ["Model", "    name: Widget", "", "    geometry    none", "Parts", "    part1", "    part2"].join(
    "\n",
  );
  const sections = parseCardText(text);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0], { heading: "Model", body: ["name: Widget", "geometry    none"] });
  assert.deepEqual(sections[1], { heading: "Parts", body: ["part1", "part2"] });
});

test("parseCardText: no banner present — first non-empty line still becomes a heading", () => {
  const text = ["Model", "    name: Widget"].join("\n");
  const sections = parseCardText(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "Model");
});

test("parseCardText: an indented line before any heading is kept under an empty heading", () => {
  const text = ["    stray body line", "Model", "    name: Widget"].join("\n");
  const sections = parseCardText(text);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0], { heading: "", body: ["stray body line"] });
  assert.equal(sections[1].heading, "Model");
});

test("parseCardText: text with only leading blank lines and a banner yields no sections", () => {
  const text = ["", "kSTEP preview -- x.kstep.kts", ""].join("\n");
  assert.deepEqual(parseCardText(text), []);
});

// ── renderGeometry (MAJOR finding — previously zero test coverage for the
// only security-relevant function in the plugin) ──────────────────────────

test("renderGeometry: strips <script> and <foreignObject> from the CLI's SVG before it reaches the DOM (tamper test)", () => {
  // This is the "Defence in depth" sanitisation renderGeometry documents in
  // its own comment — the one thing standing between arbitrary content in a
  // kstep-cli SVG response and active content landing in Obsidian's renderer
  // DOM. A refactor that weakens, removes, or reorders this call ahead of
  // the appendChild would previously pass every other check in the repo.
  const container = new FakeElement("div");
  const svg =
    '<svg width="100" height="100">' +
    "<script>alert(1)</script>" +
    '<foreignObject><div class="evil">evil</div></foreignObject>' +
    '<polygon points="0,0 10,0 10,10"/>' +
    "</svg>";
  const json = { geometry: { detected: true, shapeCount: 1 } };

  renderGeometry(container, svg, json);

  assert.equal(container.queryAll("script").length, 0, "expected <script> to be stripped");
  assert.equal(container.queryAll("foreignObject").length, 0, "expected <foreignObject> to be stripped");
  assert.equal(container.queryAll("polygon").length, 1, "expected the legitimate <polygon> to survive");
  assert.ok(!container.allText().includes("evil"), "expected the foreignObject's own content to be gone too");
});

test("renderGeometry: removes width/height from the SVG root before embedding it", () => {
  const container = new FakeElement("div");
  const svg = '<svg width="100" height="50"><polygon points="0,0 1,1 1,0"/></svg>';
  const json = { geometry: { detected: true, shapeCount: 1 } };

  renderGeometry(container, svg, json);

  const [svgEl] = container.queryAll("svg");
  assert.ok(svgEl, "expected the sanitised <svg> root to be appended into the plate");
  assert.equal(svgEl.getAttribute("width"), null);
  assert.equal(svgEl.getAttribute("height"), null);
});

test("renderGeometry: malformed SVG renders an invocation-error card instead of throwing (parsererror path)", () => {
  const container = new FakeElement("div");
  const malformed = "<svg><g></svg>"; // mismatched closing tag
  const json = { geometry: { detected: true, shapeCount: 1 } };

  assert.doesNotThrow(() => renderGeometry(container, malformed, json));

  const titles = container.queryAllByClass("kstep-error-title").map((el) => el.textContent);
  assert.deepEqual(titles, ["Could not parse the rendered SVG"]);
});

test("renderGeometry: a well-formed SVG whose root element is itself one of sanitizeSvgDoc's removal targets renders an invocation-error card instead of throwing", () => {
  // Distinct from the parsererror test above: this input parses cleanly (it
  // is well-formed XML), so `doc.querySelector("parsererror")` finds
  // nothing and execution reaches `sanitizeSvgDoc`. That sanitiser strips
  // whole elements — script/foreignObject/style/the SMIL animation tags —
  // by tag name alone, with no special case for "but not if it's the
  // document's root element". A `<style>`-rooted payload (plausible if a
  // kstep-cli script's stdout got mangled upstream — the SVG text is
  // arbitrary user-script output, not just the CLI's own writer, per
  // sanitizeSvgDoc's own doc comment) is exactly such a case: the sanitiser
  // removes the root, and a real `DOMParser`'s `document.documentElement`
  // becomes `null` per spec afterwards. `renderGeometry` must guard that
  // instead of dereferencing it unconditionally.
  const container = new FakeElement("div");
  const svg = "<style>* { fill: red; }</style>";
  const json = { geometry: { detected: true, shapeCount: 1 } };

  assert.doesNotThrow(() => renderGeometry(container, svg, json));

  const titles = container.queryAllByClass("kstep-error-title").map((el) => el.textContent);
  assert.deepEqual(titles, ["Could not parse the rendered SVG"]);
});

test("renderGeometry: shapeCount > 1 shows the 'Showing shape 1 of N' note", () => {
  const container = new FakeElement("div");
  const svg = '<svg width="10" height="10"><polygon points="0,0 1,1 1,0"/></svg>';
  const json = { geometry: { detected: true, shapeCount: 3 } };

  renderGeometry(container, svg, json);

  assert.ok(container.allText().includes("Showing shape 1 of 3."));
});

test("renderGeometry: shapeCount === 1 shows no shape-count note", () => {
  const container = new FakeElement("div");
  const svg = '<svg width="10" height="10"><polygon points="0,0 1,1 1,0"/></svg>';
  const json = { geometry: { detected: true, shapeCount: 1 } };

  renderGeometry(container, svg, json);

  assert.ok(!container.allText().includes("Showing shape"));
});

// ── renderGeometry sanitisation hardening (ported from obsidian-ktriz) ────

test("renderGeometry: strips <style>, SMIL animation elements, on* handlers, style attributes, and external href/xlink:href", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg width="10" height="10">' +
    "<style>* { fill: red; }</style>" +
    '<rect onclick="alert(1)" style="fill:url(https://evil.example/x)" width="1" height="1"/>' +
    '<image href="https://evil.example/beacon.png"/>' +
    '<image xlink:href="https://evil.example/beacon2.png"/>' +
    '<image href="#local-fragment">' +
    '<set attributeName="href" to="https://evil.example/via-set.png" begin="0s"/>' +
    "</image>" +
    '<animate attributeName="x" to="1" begin="0s"/>' +
    '<animateTransform attributeName="transform" to="translate(1,1)" begin="0s"/>' +
    '<animateMotion begin="0s"/>' +
    "<discard/>" +
    '<polygon points="0,0 1,1 1,0"/>' +
    "</svg>";

  renderGeometry(container, svg, json);

  for (const tag of ["style", "set", "animate", "animateTransform", "animateMotion", "discard"]) {
    assert.equal(container.queryAll(tag).length, 0, `expected <${tag}> to be stripped`);
  }
  const [rect] = container.queryAll("rect");
  assert.equal(rect.getAttribute("onclick"), null, "expected onclick to be stripped");
  assert.equal(rect.getAttribute("style"), null, "expected style attribute to be stripped");

  const images = container.queryAll("image");
  assert.equal(images.length, 3);
  assert.equal(images[0].getAttribute("href"), null, "expected external href to be stripped");
  assert.equal(images[1].getAttribute("xlink:href"), null, "expected external xlink:href to be stripped");
  assert.equal(images[2].getAttribute("href"), "#local-fragment", "expected a same-document fragment href to survive");

  assert.equal(container.queryAll("polygon").length, 1, "expected the legitimate <polygon> to survive");
});

test("renderGeometry: drops an attribute value that invokes a disallowed CSS function (allowlist gate)", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg width="10" height="10">' +
    '<rect cursor="image-set(&quot;https://evil.example/beacon.png&quot; 1x), auto" width="1" height="1"/>' +
    "</svg>";

  renderGeometry(container, svg, json);

  const [rect] = container.queryAll("rect");
  assert.equal(rect.getAttribute("cursor"), null, "expected the disallowed CSS function to drop the attribute");
});

test("renderGeometry: keeps a same-fragment url(#id) and an allowlisted transform function", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg width="10" height="10">' +
    '<rect fill="url(#gradient1)" transform="translate(2,3)" width="1" height="1"/>' +
    "</svg>";

  renderGeometry(container, svg, json);

  const [rect] = container.queryAll("rect");
  assert.equal(rect.getAttribute("fill"), "url(#gradient1)");
  assert.equal(rect.getAttribute("transform"), "translate(2,3)");
});

test("renderGeometry: drops an attribute value containing a backslash (CSS-escape defence)", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg width="10" height="10">' +
    '<rect fill="\\75 rl(https://evil.example/beacon.png)" width="1" height="1"/>' +
    "</svg>";

  renderGeometry(container, svg, json);

  const [rect] = container.queryAll("rect");
  assert.equal(rect.getAttribute("fill"), null, "expected the backslash-bearing value to be dropped outright");
});

// ── renderGeometry: foreign-namespaced elements (XHTML <img>/<iframe>/
// <object> mixed into the SVG) — these fire a live request the moment
// they're appended to the DOM and match none of the tag-name or
// attribute-name checks above, so they must be dropped by namespace ────────

test("renderGeometry: strips nested foreign-namespaced <img>/<iframe>/<object> elements (namespace defence)", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<rect width="1" height="1"/>' +
    '<img xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/beacon.png"/>' +
    '<iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/page"></iframe>' +
    '<object xmlns="http://www.w3.org/1999/xhtml" data="https://evil.example/thing"></object>' +
    "</svg>";

  renderGeometry(container, svg, json);

  for (const tag of ["img", "iframe", "object"]) {
    assert.equal(container.queryAll(tag).length, 0, `expected foreign-namespaced <${tag}> to be stripped`);
  }
  assert.equal(container.queryAll("rect").length, 1, "expected the legitimate SVG-namespaced <rect> to survive");
});

test("renderGeometry: a foreign-namespaced root element renders an invocation-error card instead of a live element", () => {
  // Mirrors the sanitizer's other root-is-a-removal-target case (the
  // <style>-rooted payload tested above): a payload whose entire root is
  // outside the SVG namespace must not survive as a live HTMLIFrameElement
  // once appended — `sanitizeSvgDoc`'s namespace pass removes it just like
  // any other foreign-namespaced element, `documentElement` becomes `null`
  // per DOM spec, and `renderGeometry`'s existing null guard takes over.
  const container = new FakeElement("div");
  const svg = '<iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/page"></iframe>';
  const json = { geometry: { detected: true, shapeCount: 1 } };

  assert.doesNotThrow(() => renderGeometry(container, svg, json));

  assert.equal(container.queryAll("iframe").length, 0, "expected the foreign-namespaced root to never be appended");
  const titles = container.queryAllByClass("kstep-error-title").map((el) => el.textContent);
  assert.deepEqual(titles, ["Could not parse the rendered SVG"]);
});

test("renderGeometry: strips src/data/srcdoc/poster/formaction attributes even on legitimate SVG-namespaced elements (defence in depth)", () => {
  const container = new FakeElement("div");
  const json = { geometry: { detected: true, shapeCount: 1 } };
  const svg =
    '<svg width="10" height="10">' +
    '<rect src="https://evil.example/a" data="https://evil.example/b" srcdoc="&lt;script&gt;1&lt;/script&gt;" poster="https://evil.example/c" formaction="https://evil.example/d" width="1" height="1"/>' +
    "</svg>";

  renderGeometry(container, svg, json);

  const [rect] = container.queryAll("rect");
  for (const attr of ["src", "data", "srcdoc", "poster", "formaction"]) {
    assert.equal(rect.getAttribute(attr), null, `expected ${attr} to be stripped`);
  }
});

// ── renderSummary / renderNotice: fallback to raw text when unstructured ──

test("renderSummary: falls back to a raw <pre> block when fewer than 2 sections are found", () => {
  const container = new FakeElement("div");
  renderSummary(container, "just one unstructured line");
  const pres = container.queryAll("pre");
  assert.equal(pres.length, 1);
  assert.equal(pres[0].textContent, "just one unstructured line");
});

test("renderSummary: structured text renders headings and body, plus the product-structure note", () => {
  const container = new FakeElement("div");
  const text = ["Model", "    name: Widget", "Parts", "    part1"].join("\n");
  renderSummary(container, text);
  assert.ok(container.allText().includes("Product structure only"));
  assert.ok(container.allText().includes("Model"));
  assert.ok(container.allText().includes("part1"));
});

test("renderNotice: known fallbackReason maps to its friendly message", () => {
  const container = new FakeElement("div");
  const json = { fallbackReason: "occt_unavailable", geometry: {}, occt: { available: false } };
  renderNotice(container, "Model\n    name: Widget", json);
  assert.ok(container.allText().includes("OCCT is not available on this machine"));
});

test("renderNotice: unknown fallbackReason is shown verbatim rather than a generic message", () => {
  const container = new FakeElement("div");
  const json = { fallbackReason: "some_new_reason_the_ui_has_no_copy_for", geometry: {}, occt: {} };
  renderNotice(container, "Model\n    name: Widget", json);
  assert.ok(container.allText().includes("some_new_reason_the_ui_has_no_copy_for"));
});

// ── renderCliError: every errorKind branch (MAJOR finding — only
// compilation_error had coverage before) ──────────────────────────────────

test("renderCliError: compilation_error lists each diagnostic with line:column", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "compilation_error",
    code: "KSTEP-S-001",
    diagnostics: [
      { severity: "ERROR", message: "Syntax error: Expecting '}'.", line: 3, column: 1 },
      { severity: "ERROR", message: "Unresolved reference", line: null, column: null },
    ],
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["3:1 — Syntax error: Expecting '}'.", "Unresolved reference"]);
});

test("renderCliError: validation_failed lists each violation with its rule code and entity", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "validation_failed",
    violations: [
      {
        code: "SCHEMA-1",
        entityName: "Bolt",
        ruleLabel: "required attribute",
        expressionText: "SELF.length > 0",
        message: "length must be positive",
      },
    ],
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["[SCHEMA-1] Bolt: length must be positive"]);
});

test("renderCliError: runtime_error shows the message and exception class", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "runtime_error",
    code: "KSTEP-R-001",
    message: "Division by zero",
    exceptionClass: "ArithmeticException",
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["Division by zero (ArithmeticException)"]);
});

test("renderCliError: no_model_produced shows the plain message", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "no_model_produced",
    code: "KSTEP-N-001",
    message: "The script did not produce a model.",
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["The script did not produce a model."]);
});

test("renderCliError: io_error shows the plain message", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "io_error",
    message: "Could not write output file.",
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["Could not write output file."]);
});

test("renderCliError: geometry_unavailable shows the fallbackReason, never occt.reason", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "geometry_unavailable",
    fallbackReason: "OCCT native library missing",
    occt: { available: false, reason: "/home/someone/secret/path/libocct.so not found" },
  });
  const items = container.queryAll("li").map((li) => li.textContent);
  assert.deepEqual(items, ["OCCT native library missing"]);
  // The whole point of the discriminated union in KStepResult.ts: occt.reason
  // must never reach the DOM (it can contain a local path/username).
  assert.ok(!container.allText().includes("/home/someone/secret/path"));
});

test("renderCliError: every branch always renders the fixed title, regardless of errorKind", () => {
  const container = new FakeElement("div");
  renderCliError(container, {
    status: "error",
    command: "render",
    errorKind: "io_error",
    message: "boom",
  });
  const titles = container.queryAllByClass("kstep-error-title").map((el) => el.textContent);
  assert.deepEqual(titles, ["kSTEP render error"]);
});

// ── renderInvocationError ───────────────────────────────────────────────

test("renderInvocationError: shows the title and detail verbatim", () => {
  const container = new FakeElement("div");
  renderInvocationError(container, "kSTEP CLI not found: /bin/kstep-cli", "Set the path in Settings.");
  assert.ok(container.allText().includes("kSTEP CLI not found: /bin/kstep-cli"));
  assert.ok(container.allText().includes("Set the path in Settings."));
});

// ── renderGeometry: the 3D toggle button ────────────────────────────────
// Design report §3.1: button visibility is decided from the SVG-run JSON's
// `geometry.meshTriangleCount` (blockOffersViewer), NOT `glb.triangleCount`
// (which this JSON never carries at all).

const simpleSvg = '<svg width="10" height="10"><polygon points="0,0 1,1 1,0"/></svg>';

function geometryJsonWithMesh(meshTriangleCount) {
  return { content: "geometry", geometry: { detected: true, shapeCount: 1, meshTriangleCount } };
}

test("renderGeometry: without onOpen3d, no 3D toggle button appears (bestandsschutz — existing behaviour unchanged)", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(12));
    assert.equal(container.queryAllByClass("kstep-3d-toggle").length, 0);
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: with onOpen3d + geometry JSON (meshTriangleCount > 0) + WebGL2 available, exactly one 3D toggle button appears", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(12), () => {});
    const buttons = container.queryAllByClass("kstep-3d-toggle");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, "3D");
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: with onOpen3d but WebGL2 unavailable, no 3D toggle button appears", () => {
  installFakeWebGl2(false);
  try {
    const container = new FakeElement("div");
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(12), () => {});
    assert.equal(container.queryAllByClass("kstep-3d-toggle").length, 0);
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: with onOpen3d but meshTriangleCount === 0, no 3D toggle button appears", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(0), () => {});
    assert.equal(container.queryAllByClass("kstep-3d-toggle").length, 0);
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: clicking the 3D toggle calls onOpen3d(host, poster) exactly once and flips the label to 2D", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    let calls = [];
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(12), (host, poster) => {
      calls.push({ host, poster });
    });
    const [toggle] = container.queryAllByClass("kstep-3d-toggle");
    const [host] = container.queryAllByClass("kstep-viewer");
    const [plate] = container.queryAllByClass("kstep-plate");

    toggle.dispatch("click");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, host);
    assert.equal(calls[0].poster, plate);
    assert.equal(toggle.textContent, "2D");
    assert.equal(host.hidden, false);
    assert.equal(plate.hidden, true);
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: toggling back to 2D does not call onOpen3d again and restores the poster", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    let calls = 0;
    renderGeometry(container, simpleSvg, geometryJsonWithMesh(12), () => {
      calls++;
    });
    const [toggle] = container.queryAllByClass("kstep-3d-toggle");
    const [host] = container.queryAllByClass("kstep-viewer");
    const [plate] = container.queryAllByClass("kstep-plate");

    toggle.dispatch("click"); // -> 3D
    toggle.dispatch("click"); // -> back to 2D

    assert.equal(calls, 1, "onOpen3d must not be called again when switching back to 2D");
    assert.equal(toggle.textContent, "3D");
    assert.equal(host.hidden, true);
    assert.equal(plate.hidden, false);
  } finally {
    installFakeWebGl2();
  }
});

test("renderGeometry: onOpen3d + summary content never shows a 3D toggle (blockOffersViewer requires content === 'geometry')", () => {
  installFakeWebGl2(true);
  try {
    const container = new FakeElement("div");
    const json = { content: "summary", geometry: { detected: false, shapeCount: 1, meshTriangleCount: 12 } };
    renderGeometry(container, simpleSvg, json, () => {});
    assert.equal(container.queryAllByClass("kstep-3d-toggle").length, 0);
  } finally {
    installFakeWebGl2();
  }
});

// ── renderViewerError ────────────────────────────────────────────────────

test("renderViewerError: paints a title and detail into the given host", () => {
  const host = new FakeElement("div");
  renderViewerError(host, "Could not display the 3D model", "Something went wrong.");
  const titles = host.queryAllByClass("kstep-error-title").map((el) => el.textContent);
  assert.deepEqual(titles, ["Could not display the 3D model"]);
  assert.ok(host.allText().includes("Something went wrong."));
});

test("renderViewerError: does not touch a sibling poster element", () => {
  const wrap = new FakeElement("div");
  const poster = wrap.createDiv({ cls: "kstep-plate" });
  poster.createEl("svg", {});
  const host = wrap.createDiv({ cls: "kstep-viewer" });

  renderViewerError(host, "title", "detail");

  assert.equal(poster.queryAll("svg").length, 1, "the poster's own content must be untouched");
});

// ── Regression: summary/notice/cliError never produce a 3D-related button ──

test("renderSummary/renderNotice/renderCliError: never emit any <button> (geometry-only feature)", () => {
  const c1 = new FakeElement("div");
  renderSummary(c1, "Model\n    name: Widget");
  assert.equal(c1.queryAll("button").length, 0);

  const c2 = new FakeElement("div");
  renderNotice(c2, "Model\n    name: Widget", { fallbackReason: "occt_unavailable", geometry: {}, occt: {} });
  assert.equal(c2.queryAll("button").length, 0);

  const c3 = new FakeElement("div");
  renderCliError(c3, { status: "error", command: "render", errorKind: "io_error", message: "boom" });
  assert.equal(c3.queryAll("button").length, 0);
});
