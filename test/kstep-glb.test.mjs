import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers/loadModule.mjs";

const { validateGlb, blockOffersViewer, shouldOfferViewer, hasWebGl2, ViewerRegistry } = await loadModule(
  "src/KStepGlb.ts",
);

// ── Test fixture builder ────────────────────────────────────────────────
// Builds a minimal, spec-shaped GLB buffer (header + a single JSON chunk, no
// binary chunk — glTF 2.0 permits a JSON-only GLB, and `validateGlb` never
// inspects a binary chunk's own contents) from a plain JS object, so every
// test below constructs its fixture from a legible object literal rather
// than a hand-crafted byte array.

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;

function minimalGltfJson(overrides = {}) {
  return {
    asset: { version: "2.0" },
    ...overrides,
  };
}

/** Builds a real, well-formed GLB ArrayBuffer around `jsonObj`. */
function buildGlb(jsonObj) {
  const jsonText = JSON.stringify(jsonObj);
  const jsonRaw = Buffer.from(jsonText, "utf8");
  const pad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBytes = Buffer.concat([jsonRaw, Buffer.alloc(pad, 0x20)]); // glTF pads JSON chunks with spaces
  const totalLength = 12 + 8 + jsonBytes.length;
  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32LE(GLB_MAGIC, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(totalLength, 8);
  buf.writeUInt32LE(jsonBytes.length, 12);
  buf.writeUInt32LE(GLB_JSON_CHUNK_TYPE, 16);
  jsonBytes.copy(buf, 20);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Builds a raw ArrayBuffer directly from bytes, bypassing `buildGlb`'s spec-shaping — for malformed-header cases. */
function rawBuffer(bytes) {
  const buf = Buffer.from(bytes);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ── validateGlb ──────────────────────────────────────────────────────────

test("validateGlb: a real, well-formed GLB (no external refs) validates ok", () => {
  const glb = buildGlb(minimalGltfJson({ buffers: [{ byteLength: 864 }] }));
  const result = validateGlb(glb);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.header.version, 2);
    assert.equal(result.header.totalLength, glb.byteLength);
  }
});

test("validateGlb: bad magic is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const view = new DataView(glb);
  view.setUint32(0, 0xdeadbeef, true);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /magic/i);
});

test("validateGlb: version 1 is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const view = new DataView(glb);
  view.setUint32(4, 1, true);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /version/i);
});

test("validateGlb: a truncated buffer (< 20 bytes) is rejected", () => {
  const result = validateGlb(rawBuffer([1, 2, 3, 4, 5]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /too short/i);
});

test("validateGlb: header length mismatched against the real buffer size is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const view = new DataView(glb);
  view.setUint32(8, glb.byteLength + 100, true);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /header length/i);
});

test("validateGlb: reportedByteLength mismatch (from json.glb.byteLength) is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const result = validateGlb(glb, glb.byteLength + 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /reported byteLength/i);
});

test("validateGlb: chunk 0 with a non-JSON type is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const view = new DataView(glb);
  view.setUint32(16, 0x004e4942, true); // "BIN\0" chunk type where JSON was expected
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not a json chunk/i);
});

test("validateGlb: a JSON chunk length that runs past the buffer's end is rejected", () => {
  const glb = buildGlb(minimalGltfJson());
  const view = new DataView(glb);
  view.setUint32(12, 10_000_000, true);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /extends past/i);
});

test("validateGlb: a JSON chunk that is not valid JSON is rejected, not thrown", () => {
  const glb = buildGlb(minimalGltfJson());
  // Corrupt a byte inside the JSON chunk (starts at offset 20) without
  // changing its length, so this exercises the JSON.parse failure path
  // specifically rather than the length-mismatch path above.
  const bytes = new Uint8Array(glb);
  bytes[20] = "!".charCodeAt(0); // '{' -> '!' — no longer valid JSON
  assert.doesNotThrow(() => validateGlb(glb));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not valid json/i);
});

test("validateGlb: buffers[].uri (tamper test — network-fetch guard) is rejected", () => {
  const glb = buildGlb(minimalGltfJson({ buffers: [{ uri: "https://evil.example/x.bin", byteLength: 12 }] }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /external "uri"/i);
});

test("validateGlb: images[].uri (tamper test — network-fetch guard) is rejected", () => {
  const glb = buildGlb(minimalGltfJson({ images: [{ uri: "https://evil.example/x.png" }] }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /external "uri"/i);
});

test("validateGlb: extensionsRequired is rejected (unsupported-extension guard)", () => {
  const glb = buildGlb(minimalGltfJson({ extensionsRequired: ["KHR_draco_mesh_compression"] }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /extensionsRequired/);
});

test("validateGlb: extensionsUsed is also rejected", () => {
  const glb = buildGlb(minimalGltfJson({ extensionsUsed: ["KHR_materials_unlit"] }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /extensionsUsed/);
});

// ── multi-chunk guard (MAJOR finding, security review — see KStepGlb.ts's
// `validateGlb` doc comment for the PoC: a real `three` `GLTFBinaryExtension`
// walks every chunk and lets the LAST JSON chunk win, so a chunk-0-only
// inspection can be bypassed by a clean chunk 0 followed by a malicious
// second JSON chunk) ─────────────────────────────────────────────────────

/**
 * Builds a GLB with TWO consecutive chunks: `firstJson` as chunk 0 (always
 * typed JSON) and `secondBytes` as a second chunk of `secondType`. Used to
 * construct the exact PoC shape from the security review — a clean chunk 0
 * followed by a second, malicious JSON chunk — as well as adjacent
 * non-JSON-chunk-type and trailing-byte cases.
 */
function buildGlbWithSecondChunk(firstJson, secondBytes, secondType) {
  const firstText = JSON.stringify(firstJson);
  const firstRaw = Buffer.from(firstText, "utf8");
  const firstPad = (4 - (firstRaw.length % 4)) % 4;
  const firstChunk = Buffer.concat([firstRaw, Buffer.alloc(firstPad, 0x20)]);

  const secondPad = (4 - (secondBytes.length % 4)) % 4;
  const secondChunk = Buffer.concat([secondBytes, Buffer.alloc(secondPad, 0x00)]);

  const totalLength = 12 + 8 + firstChunk.length + 8 + secondChunk.length;
  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32LE(GLB_MAGIC, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(totalLength, 8);

  buf.writeUInt32LE(firstChunk.length, 12);
  buf.writeUInt32LE(GLB_JSON_CHUNK_TYPE, 16);
  firstChunk.copy(buf, 20);

  const secondOffset = 20 + firstChunk.length;
  buf.writeUInt32LE(secondChunk.length, secondOffset);
  buf.writeUInt32LE(secondType, secondOffset + 4);
  secondChunk.copy(buf, secondOffset + 8);

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("validateGlb: a clean chunk 0 followed by a second JSON chunk with an external uri is rejected (multi-chunk PoC)", () => {
  // Exactly the security review's PoC shape: chunk 0 is a harmless glTF JSON
  // object (what a naive chunk-0-only validator sees and approves), chunk 1
  // is a SECOND JSON chunk carrying the malicious buffers[]/images[] uris —
  // the object `three`'s GLTFBinaryExtension actually hands to GLTFLoader.parse.
  const cleanChunk0 = minimalGltfJson({ scenes: [], nodes: [] });
  const maliciousChunk1 = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      images: [{ uri: "https://evil.example/beacon.png" }],
      buffers: [{ uri: "https://evil.example/exfil.bin" }],
    }),
    "utf8",
  );
  const glb = buildGlbWithSecondChunk(cleanChunk0, maliciousChunk1, GLB_JSON_CHUNK_TYPE);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /more than one json chunk/i);
});

test("validateGlb: a second JSON chunk is rejected even when it is itself clean", () => {
  // The guard rejects on chunk TYPE alone — a second JSON chunk is refused
  // regardless of its own content, since a spec-conformant GLB never has one.
  const glb = buildGlbWithSecondChunk(
    minimalGltfJson(),
    Buffer.from(JSON.stringify({ asset: { version: "2.0" } }), "utf8"),
    GLB_JSON_CHUNK_TYPE,
  );
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /more than one json chunk/i);
});

test("validateGlb: a well-formed chunk 0 + a single BIN chunk still validates ok", () => {
  // Confirms the multi-chunk guard does not reject the ordinary, spec-shaped
  // two-chunk GLB (JSON + BIN) that a real kstep-cli output with actual
  // binary buffer data would use.
  const glb = buildGlbWithSecondChunk(
    minimalGltfJson({ buffers: [{ byteLength: 4 }] }),
    Buffer.from([1, 2, 3, 4]),
    0x004e4942, // "BIN\0"
  );
  const result = validateGlb(glb);
  assert.equal(result.ok, true);
});

test("validateGlb: a chunk type after chunk 0 that is neither JSON nor BIN is rejected", () => {
  const glb = buildGlbWithSecondChunk(minimalGltfJson(), Buffer.from([0, 0, 0, 0]), 0x12345678);
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unsupported chunk type/i);
});

test("validateGlb: an incomplete trailing chunk header after the last full chunk (header length inflated to cover it) is rejected", () => {
  // Builds a normal single-JSON-chunk GLB, then appends 4 unaccounted extra
  // bytes — too few to form a full 8-byte chunk header — and inflates the
  // header's total-length field to match the new buffer size, so the
  // top-level "does totalLength match byteLength" check passes and only the
  // chunk walk itself can catch the dangling bytes.
  const glb = buildGlb(minimalGltfJson());
  const bytes = new Uint8Array(glb);
  const withTrailer = new Uint8Array(bytes.length + 4);
  withTrailer.set(bytes);
  withTrailer.set([0xde, 0xad, 0xbe, 0xef], bytes.length);
  const view = new DataView(withTrailer.buffer);
  view.setUint32(8, withTrailer.length, true);
  const result = validateGlb(withTrailer.buffer);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /chunk header extends past/i);
});

test("validateGlb: a trailing zero-length BIN chunk that fully accounts for itself in the header is a well-formed three-chunk-shaped GLB and validates ok", () => {
  // A trailing chunk with a complete, self-consistent 8-byte header (even a
  // degenerate zero-length one) is not "unaccounted trailing bytes" — the
  // chunk walk consumes it exactly, confirming the guard rejects only
  // genuinely dangling/incomplete data, not every non-JSON/BIN-standard
  // buffer shape.
  const glb = buildGlb(minimalGltfJson());
  const bytes = new Uint8Array(glb);
  const withTrailer = new Uint8Array(bytes.length + 8);
  withTrailer.set(bytes);
  const view = new DataView(withTrailer.buffer);
  view.setUint32(bytes.length, 0, true); // chunkLength = 0
  view.setUint32(bytes.length + 4, 0x004e4942, true); // "BIN\0"
  view.setUint32(8, withTrailer.length, true); // header totalLength now covers the trailer
  const result = validateGlb(withTrailer.buffer);
  assert.equal(result.ok, true);
});

// ── asset.version guard (MINOR finding, this wave's review) ───────────────
// Belt-and-suspenders mirror of GLTFLoader.parse's own synchronous
// `json.asset === undefined || json.asset.version[0] < 2` check — see
// Kstep3dController.ts's own comment on why catching this here, before a
// WebGL context is ever created, matters in addition to that controller's
// own synchronous-onAsyncError handling.

test("validateGlb: a JSON chunk with no \"asset\" object at all is rejected", () => {
  const glb = buildGlb({ buffers: [{ byteLength: 12 }] }); // no minimalGltfJson() base — omits `asset` entirely
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /missing a required "asset" object/i);
});

test("validateGlb: an \"asset\" object with no usable \"version\" string is rejected", () => {
  const glb = buildGlb(minimalGltfJson({ asset: {} }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /missing a usable "version" string/i);
});

test("validateGlb: asset.version \"1.0\" (unsupported glTF major version) is rejected", () => {
  const glb = buildGlb(minimalGltfJson({ asset: { version: "1.0" } }));
  const result = validateGlb(glb);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unsupported glTF JSON asset version/i);
});

// ── blockOffersViewer / shouldOfferViewer ──────────────────────────────────
// blockOffersViewer reads the SVG-run JSON (geometry.meshTriangleCount, no
// `glb` field present); shouldOfferViewer reads the GLB-run JSON
// (glb.triangleCount). Both must agree for the cases that matter (non-zero
// triangles on a geometry response) and both must be false for summary/
// notice responses, per the design report's predicate correction (§3.1).

function svgRunJson(content, meshTriangleCount) {
  return { content, geometry: { detected: content === "geometry", shapeCount: 1, meshTriangleCount } };
}

function glbRunJson(content, glbTriangleCount) {
  return {
    content,
    geometry: { detected: content === "geometry", shapeCount: 1 },
    glb: glbTriangleCount === undefined ? undefined : { triangleCount: glbTriangleCount, vertexCount: 0, droppedTriangleCount: 0, byteLength: 0 },
  };
}

test("blockOffersViewer: geometry with meshTriangleCount > 0 is true", () => {
  assert.equal(blockOffersViewer(svgRunJson("geometry", 12)), true);
});
test("blockOffersViewer: geometry with meshTriangleCount === 0 is false", () => {
  assert.equal(blockOffersViewer(svgRunJson("geometry", 0)), false);
});
test("blockOffersViewer: geometry with meshTriangleCount undefined is false", () => {
  assert.equal(blockOffersViewer(svgRunJson("geometry", undefined)), false);
});
test("blockOffersViewer: summary content is false regardless of counts", () => {
  assert.equal(blockOffersViewer(svgRunJson("summary", 12)), false);
});
test("blockOffersViewer: notice content is false regardless of counts", () => {
  assert.equal(blockOffersViewer(svgRunJson("notice", 12)), false);
});

test("shouldOfferViewer: geometry with glb.triangleCount > 0 is true", () => {
  assert.equal(shouldOfferViewer(glbRunJson("geometry", 12)), true);
});
test("shouldOfferViewer: geometry with glb.triangleCount === 0 is false", () => {
  assert.equal(shouldOfferViewer(glbRunJson("geometry", 0)), false);
});
test("shouldOfferViewer: geometry with glb undefined is false", () => {
  assert.equal(shouldOfferViewer(glbRunJson("geometry", undefined)), false);
});
test("shouldOfferViewer: summary content is false", () => {
  assert.equal(shouldOfferViewer(glbRunJson("summary", 12)), false);
});
test("shouldOfferViewer: notice content is false", () => {
  assert.equal(shouldOfferViewer(glbRunJson("notice", 12)), false);
});

// ── hasWebGl2 (MAJOR regression — memoization + probe-context release) ────
// test/kstep-card.test.mjs's `installFakeWebGl2` exercises hasWebGl2()
// indirectly (through renderGeometry's button-visibility decision, across a
// bundle that imports THIS module); these tests exercise it directly, and
// specifically the call-count/reuse behaviour that a card-level test can't
// observe.

/** A fake `document` whose `createElement("canvas")` hands back a fresh fake canvas each time, recording every `getContext`/`getExtension`/`loseContext` call on a shared `calls` object. */
function fakeWebGlDocument(available, calls) {
  return {
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`unexpected createElement("${tag}")`);
      return {
        getContext(type) {
          calls.getContextCalls++;
          if (!(available && type === "webgl2")) return null;
          return {
            getExtension(name) {
              calls.getExtensionCalls.push(name);
              if (name !== "WEBGL_lose_context") return null;
              return {
                loseContext() {
                  calls.loseContextCalls++;
                },
              };
            },
          };
        },
      };
    },
  };
}

test("hasWebGl2: probes only once per distinct `document`, reusing the cached result on later calls", () => {
  try {
    const calls = { getContextCalls: 0, getExtensionCalls: [], loseContextCalls: 0 };
    globalThis.document = fakeWebGlDocument(true, calls);

    assert.equal(hasWebGl2(), true);
    assert.equal(hasWebGl2(), true);
    assert.equal(hasWebGl2(), true);

    assert.equal(calls.getContextCalls, 1, "a real probe context must be created at most once per `document`");
  } finally {
    delete globalThis.document;
  }
});

test("hasWebGl2: releases its own probe context via WEBGL_lose_context instead of leaking it", () => {
  try {
    const calls = { getContextCalls: 0, getExtensionCalls: [], loseContextCalls: 0 };
    globalThis.document = fakeWebGlDocument(true, calls);

    hasWebGl2();

    assert.deepEqual(calls.getExtensionCalls, ["WEBGL_lose_context"]);
    assert.equal(calls.loseContextCalls, 1);
  } finally {
    delete globalThis.document;
  }
});

test("hasWebGl2: a fresh `document` object is re-probed, not served the previous document's cached result", () => {
  try {
    const unavailableCalls = { getContextCalls: 0, getExtensionCalls: [], loseContextCalls: 0 };
    globalThis.document = fakeWebGlDocument(false, unavailableCalls);
    assert.equal(hasWebGl2(), false);

    const availableCalls = { getContextCalls: 0, getExtensionCalls: [], loseContextCalls: 0 };
    globalThis.document = fakeWebGlDocument(true, availableCalls);
    assert.equal(hasWebGl2(), true, "a new `document` must be probed fresh, not served the old document's cached `false`");
    assert.equal(availableCalls.getContextCalls, 1);
  } finally {
    delete globalThis.document;
  }
});

test("hasWebGl2: no `document` global at all is false, and is never cached against a later real `document`", () => {
  delete globalThis.document;
  assert.equal(hasWebGl2(), false);

  try {
    const calls = { getContextCalls: 0, getExtensionCalls: [], loseContextCalls: 0 };
    globalThis.document = fakeWebGlDocument(true, calls);
    assert.equal(hasWebGl2(), true, "a real document appearing later must still be probed, not stuck on the no-document `false`");
  } finally {
    delete globalThis.document;
  }
});

// ── ViewerRegistry ───────────────────────────────────────────────────────

function fakeHandle(label) {
  return { label, close() {} };
}

test("ViewerRegistry: activating up to `max` handles evicts nothing", () => {
  const registry = new ViewerRegistry(4);
  const handles = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c"), fakeHandle("d")];
  for (const h of handles) {
    const evicted = registry.activate(h);
    assert.deepEqual(evicted, []);
  }
  assert.equal(registry.size, 4);
});

test("ViewerRegistry: activating a 5th handle evicts exactly the oldest", () => {
  const registry = new ViewerRegistry(4);
  const [a, b, c, d] = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c"), fakeHandle("d")];
  [a, b, c, d].forEach((h) => registry.activate(h));

  const e = fakeHandle("e");
  const evicted = registry.activate(e);

  assert.deepEqual(evicted, [a]);
  assert.equal(registry.size, 4);
});

test("ViewerRegistry: release removes a handle from the middle without evicting others", () => {
  const registry = new ViewerRegistry(4);
  const [a, b, c] = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c")];
  [a, b, c].forEach((h) => registry.activate(h));

  registry.release(b);

  assert.equal(registry.size, 2);
  // b's eviction slot is now free — activating two more should not evict a or c.
  const evicted = [fakeHandle("d"), fakeHandle("e")].map((h) => registry.activate(h)).flat();
  assert.deepEqual(evicted, []);
  assert.equal(registry.size, 4);
});

test("ViewerRegistry: re-activating an already-active handle moves it to most-recently-used without double-counting", () => {
  const registry = new ViewerRegistry(4);
  const [a, b, c, d] = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c"), fakeHandle("d")];
  [a, b, c, d].forEach((h) => registry.activate(h));

  // Re-activate `a` — it should become most-recently-used, so the NEXT
  // eviction (a 5th distinct handle) should evict `b`, not `a`.
  const reactivateEvicted = registry.activate(a);
  assert.deepEqual(reactivateEvicted, []);
  assert.equal(registry.size, 4);

  const e = fakeHandle("e");
  const evicted = registry.activate(e);
  assert.deepEqual(evicted, [b]);
  assert.equal(registry.size, 4);
});

// ── ViewerRegistry: onEvicted callback (MAJOR regression — src/Kstep3dController.ts
// uses this to fall back a card to its 2D poster when its OWN handle is the
// one evicted later, by someone else's activate() call) ────────────────────

test("ViewerRegistry: onEvicted fires for the handle that gets evicted, not for the one doing the evicting", () => {
  const registry = new ViewerRegistry(4);
  const [a, b, c, d] = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c"), fakeHandle("d")];
  let aEvictedCalls = 0;
  registry.activate(a, () => aEvictedCalls++);
  [b, c, d].forEach((h) => registry.activate(h));

  let eEvictedCalls = 0;
  const evicted = registry.activate(fakeHandle("e"), () => eEvictedCalls++);

  assert.deepEqual(evicted, [a]);
  assert.equal(aEvictedCalls, 1, "a's own onEvicted must fire when a is the one evicted");
  assert.equal(eEvictedCalls, 0, "e's onEvicted must not fire from the same call that registered it");
});

test("ViewerRegistry: onEvicted is not invoked for handles closed via release()", () => {
  const registry = new ViewerRegistry(4);
  const a = fakeHandle("a");
  let evictedCalls = 0;
  registry.activate(a, () => evictedCalls++);

  registry.release(a);
  [fakeHandle("b"), fakeHandle("c"), fakeHandle("d"), fakeHandle("e")].forEach((h) => registry.activate(h));

  assert.equal(evictedCalls, 0, "release() removes the handle (and its callback) without ever counting as an eviction");
});

test("ViewerRegistry: re-activating an already-active handle without passing onEvicted again drops the earlier registration", () => {
  const registry = new ViewerRegistry(4);
  const [a, b, c, d] = [fakeHandle("a"), fakeHandle("b"), fakeHandle("c"), fakeHandle("d")];
  let aEvictedCalls = 0;
  registry.activate(a, () => aEvictedCalls++);
  [b, c, d].forEach((h) => registry.activate(h));

  registry.activate(a); // re-activated WITHOUT onEvicted this time
  [fakeHandle("e"), fakeHandle("f"), fakeHandle("g"), fakeHandle("h")].forEach((h) => registry.activate(h));
  // `a` has long since been evicted again by now (it's the oldest after its
  // own re-activation put it at the back once, then four more distinct
  // handles pushed past `max`) — the only thing under test is that its
  // now-stale callback never fires.

  assert.equal(aEvictedCalls, 0, "the earlier onEvicted registration must not survive a re-activate that omits it");
});
