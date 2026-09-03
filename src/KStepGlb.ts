import type { KStepSuccessJson } from "./KStepResult";

/**
 * Pure GLB (binary glTF) container validation and viewer-eligibility logic —
 * deliberately free of any `three` import, so this module can be bundled and
 * exercised headlessly under `node:test` without ever touching WebGL (see
 * test/kstep-glb.test.mjs). The one place that DOES import `three` is
 * KStepViewer.ts.
 *
 * GLB binary layout (glTF 2.0 spec, verified against a real kstep-cli output
 * file with a hand-written DataView parser during this wave's investigation):
 *
 *   bytes  0.. 3  magic       uint32 LE, must be 0x46546C67 ("glTF")
 *   bytes  4.. 7  version     uint32 LE, must be 2
 *   bytes  8..11  length      uint32 LE, total byte length of the file
 *   bytes 12..15  chunk0Length uint32 LE, length of the first chunk's data
 *   bytes 16..19  chunk0Type   uint32 LE, must be 0x4E4F534A ("JSON") for chunk 0
 *   bytes 20..    chunk0Data   the JSON chunk's own bytes (UTF-8, padded)
 *
 * A GLB is not limited to that one chunk — the container format is a
 * sequence of `(length, type, data)` chunks filling the buffer up to
 * `length` (the header's byte 8..11 field). glTF 2.0 permits at most one
 * JSON chunk (always first) and one BIN chunk (always second, if present).
 * `validateGlb` walks every chunk, not just chunk 0 (MAJOR finding, this
 * wave's security review — see the doc comment on `validateGlb` itself for
 * why chunk 0-only inspection is unsafe).
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a; // "JSON"
const GLB_BIN_CHUNK_TYPE = 0x004e4942; // "BIN\0"
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;

export interface GlbHeader {
  version: number;
  totalLength: number;
  jsonChunkLength: number;
}

export type GlbValidation = { ok: true; header: GlbHeader } | { ok: false; reason: string };

/**
 * Validates a GLB buffer's container structure AND, as a security guard (see
 * this wave's implementation report §3.3 / §5.2), its JSON chunk's absence of
 * any external-reference field. Never throws — every failure mode, including
 * a JSON chunk that fails to parse, comes back as `{ ok: false, reason }`.
 *
 * The URI/extension guard exists because `GLTFLoader.parse` (three.js,
 * examples/jsm/loaders/GLTFLoader.js) resolves an ABSOLUTE `https://` URI in
 * `buffers[].uri` or `images[].uri` unchanged (`LoaderUtils.resolveURL`,
 * verified by reading that source during this wave's investigation) and then
 * issues a real network request for it — the one network vector this GLB
 * pipeline would otherwise have, despite never itself creating a Blob,
 * ObjectURL, or `src` attribute. A real kstep-cli GLB never sets these
 * fields (verified: `"buffers":[{"byteLength":864}]`, no `uri` key at all),
 * so rejecting them here never rejects a legitimate render.
 *
 * This guard MUST see every JSON chunk in the buffer, not just chunk 0
 * (MAJOR finding, this wave's security review, confirmed by PoC). An earlier
 * version of this function read `jsonChunkLength`/`jsonChunkType` once at a
 * fixed offset and decoded only `[20, 20+jsonChunkLength)`, leaving anything
 * after that one chunk completely unexamined — no check that chunk 0 was the
 * buffer's only chunk, or that a later chunk wasn't ALSO typed JSON. `three`'s
 * own binary-GLTF reader (`GLTFBinaryExtension`,
 * examples/jsm/loaders/GLTFLoader.js) does not share that blind spot: it
 * walks every chunk in a `while` loop and, for each JSON-typed chunk it
 * finds, overwrites `this.content` with that chunk's decoded text — so the
 * LAST JSON chunk in the buffer, not the first, is what `GLTFLoader.parse`
 * actually renders. A GLB with a clean chunk 0 (no `uri`, no
 * `extensionsUsed`/`extensionsRequired`) followed by a second JSON chunk
 * carrying `buffers[].uri`/`images[].uri` pointing at an attacker's server
 * passed the old chunk-0-only check while three.js issued the real network
 * request from that second chunk's content — exactly the vector this guard
 * exists to close. Fixed by walking every chunk (see the loop below): a
 * second JSON chunk, or any chunk type other than JSON (first) / BIN
 * (thereafter), is refused outright, and the chunk walk must consume the
 * buffer exactly up to `totalLength` with nothing left over. A real
 * kstep-cli GLB emits exactly one JSON chunk optionally followed by one BIN
 * chunk (verified), so this never rejects a legitimate render.
 */
export function validateGlb(bytes: ArrayBuffer, reportedByteLength?: number): GlbValidation {
  if (bytes.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    return { ok: false, reason: "Buffer is too short to contain a GLB header and a chunk header." };
  }

  const view = new DataView(bytes);

  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    return { ok: false, reason: `Bad magic: expected 0x${GLB_MAGIC.toString(16)}, got 0x${magic.toString(16)}.` };
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    return { ok: false, reason: `Unsupported glTF binary version: ${version} (expected 2).` };
  }

  const totalLength = view.getUint32(8, true);
  if (totalLength !== bytes.byteLength) {
    return {
      ok: false,
      reason: `Header length (${totalLength}) does not match the actual buffer size (${bytes.byteLength}).`,
    };
  }

  if (reportedByteLength !== undefined && reportedByteLength !== bytes.byteLength) {
    return {
      ok: false,
      reason: `Reported byteLength (${reportedByteLength}) does not match the actual buffer size (${bytes.byteLength}).`,
    };
  }

  // Walk every chunk in the buffer — never just chunk 0 (see this function's
  // doc comment for the PoC this closes). glTF 2.0 permits exactly one JSON
  // chunk, always first, optionally followed by exactly one BIN chunk; any
  // second JSON chunk, or any chunk type other than JSON/BIN, is refused
  // rather than silently ignored, and the walk must land exactly on
  // `totalLength` with no unaccounted trailing bytes.
  let jsonChunkStart = -1;
  let jsonChunkLength = -1;
  let sawBinChunk = false;
  let offset = GLB_HEADER_BYTES;
  let isFirstChunk = true;
  while (offset < totalLength) {
    if (offset + GLB_CHUNK_HEADER_BYTES > bytes.byteLength) {
      return { ok: false, reason: "A chunk header extends past the end of the buffer." };
    }
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + GLB_CHUNK_HEADER_BYTES;
    const chunkDataEnd = chunkDataStart + chunkLength;
    if (chunkDataEnd > bytes.byteLength) {
      return {
        ok: false,
        reason: isFirstChunk
          ? "JSON chunk length extends past the end of the buffer."
          : "A chunk's length extends past the end of the buffer.",
      };
    }

    if (isFirstChunk) {
      if (chunkType !== GLB_JSON_CHUNK_TYPE) {
        return {
          ok: false,
          reason: `First chunk is not a JSON chunk (type 0x${chunkType.toString(16)}).`,
        };
      }
      jsonChunkStart = chunkDataStart;
      jsonChunkLength = chunkLength;
    } else if (chunkType === GLB_JSON_CHUNK_TYPE) {
      return {
        ok: false,
        reason: "GLB contains more than one JSON chunk — refused (multi-chunk guard).",
      };
    } else if (chunkType === GLB_BIN_CHUNK_TYPE) {
      if (sawBinChunk) {
        return { ok: false, reason: "GLB contains more than one BIN chunk — refused (multi-chunk guard)." };
      }
      sawBinChunk = true;
    } else {
      return {
        ok: false,
        reason: `Unsupported chunk type after chunk 0: 0x${chunkType.toString(16)} — refused (multi-chunk guard).`,
      };
    }

    offset = chunkDataEnd;
    isFirstChunk = false;
  }
  if (offset !== totalLength) {
    return { ok: false, reason: "Trailing bytes after the last chunk do not form a complete chunk." };
  }

  let parsedJson: unknown;
  try {
    const jsonBytes = new Uint8Array(bytes, jsonChunkStart, jsonChunkLength);
    const jsonText = new TextDecoder("utf-8").decode(jsonBytes);
    parsedJson = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `JSON chunk is not valid JSON: ${msg}` };
  }

  const assetVersionReason = findMissingOrUnsupportedAssetVersion(parsedJson);
  if (assetVersionReason) {
    return { ok: false, reason: assetVersionReason };
  }

  const externalRefReason = findExternalReference(parsedJson);
  if (externalRefReason) {
    return { ok: false, reason: externalRefReason };
  }

  return { ok: true, header: { version, totalLength, jsonChunkLength } };
}

/**
 * Belt-and-suspenders check (MINOR finding, this wave's review) mirroring
 * `GLTFLoader.parse`'s own synchronous guard (three.js,
 * examples/jsm/loaders/GLTFLoader.js: `if (json.asset === undefined ||
 * json.asset.version[0] < 2) { onError(...); return; }`). That branch — like
 * the `GLTFBinaryExtension` constructor's malformed-BIN-chunk branch just
 * above it in the same file — runs INSIDE `parse()`, i.e. synchronously,
 * before `mountViewer` (KStepViewer.ts) ever returns to
 * `Kstep3dController.open()`. Rejecting a JSON chunk with no usable
 * `asset.version` here, before a WebGL context is ever created for it, closes
 * that path off entirely rather than relying on `Kstep3dController`'s own
 * synchronous-`onAsyncError` handling as the only defence. A real kstep-cli
 * GLB always sets `asset.version` to `"2.0"` (verified), so this never
 * rejects a legitimate render.
 */
function findMissingOrUnsupportedAssetVersion(parsedJson: unknown): string | null {
  if (parsedJson === null || typeof parsedJson !== "object") {
    return null; // Already reported as "root is not an object" by the caller's other checks.
  }
  const asset = (parsedJson as Record<string, unknown>).asset;
  if (asset === null || typeof asset !== "object") {
    return 'JSON chunk is missing a required "asset" object.';
  }
  const version = (asset as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) {
    return 'JSON chunk\'s "asset" object is missing a usable "version" string.';
  }
  const major = Number(version[0]);
  if (!Number.isFinite(major) || major < 2) {
    return `Unsupported glTF JSON asset version: "${version}" (expected 2.x).`;
  }
  return null;
}

/**
 * Returns a human-readable reason string if the parsed glTF JSON chunk
 * declares any external reference or extension, or `null` if it is clean.
 * See `validateGlb`'s doc comment for why this check exists.
 */
function findExternalReference(parsedJson: unknown): string | null {
  if (parsedJson === null || typeof parsedJson !== "object") {
    return "JSON chunk root is not an object.";
  }
  const root = parsedJson as Record<string, unknown>;

  const uriIn = (arrayField: unknown, label: string): string | null => {
    if (!Array.isArray(arrayField)) return null;
    for (const entry of arrayField) {
      if (entry !== null && typeof entry === "object" && "uri" in (entry as Record<string, unknown>)) {
        return `${label} declares an external "uri" — refused (network-fetch guard).`;
      }
    }
    return null;
  };

  const bufferUri = uriIn(root.buffers, "A buffer");
  if (bufferUri) return bufferUri;

  const imageUri = uriIn(root.images, "An image");
  if (imageUri) return imageUri;

  if (Array.isArray(root.extensionsRequired) && root.extensionsRequired.length > 0) {
    return `Declares extensionsRequired (${JSON.stringify(root.extensionsRequired)}) — refused (unsupported-extension guard).`;
  }
  if (Array.isArray(root.extensionsUsed) && root.extensionsUsed.length > 0) {
    return `Declares extensionsUsed (${JSON.stringify(root.extensionsUsed)}) — refused (unsupported-extension guard).`;
  }

  return null;
}

/**
 * Decides whether the 3D toggle button should appear on a geometry card,
 * evaluated against the SVG-run JSON (`-f auto`, the block's normal render —
 * see main.ts). That JSON never carries a `glb` object (verified: it simply
 * isn't present in a `-f auto` response), so this reads `meshTriangleCount`
 * instead, which predicts the later `-f glb` run's `glb.triangleCount`
 * exactly (see GeometryInfo.meshTriangleCount's doc comment in
 * KStepResult.ts for why).
 */
export function blockOffersViewer(json: KStepSuccessJson): boolean {
  return json.content === "geometry" && (json.geometry.meshTriangleCount ?? 0) > 0;
}

/**
 * Decides whether a `-f glb` run's own JSON describes a GLB worth mounting a
 * viewer for. Evaluated AFTER `renderGlbViaCli` returns, against that
 * response's own JSON (which DOES carry `glb`) — distinct from
 * `blockOffersViewer` above, which decides button visibility ahead of that
 * call, from the SVG-run JSON.
 */
export function shouldOfferViewer(json: KStepSuccessJson): boolean {
  return json.content === "geometry" && (json.glb?.triangleCount ?? 0) > 0;
}

// Memoizes hasWebGl2()'s probe result against the `document` object it was
// obtained from (see that function's doc comment for why keying on identity,
// not just a plain boolean cache, matters). Module-scoped rather than a
// closure inside hasWebGl2 itself only because that is the idiomatic way to
// give a top-level exported function private persistent state in this file.
let cachedWebGl2Document: unknown;
let cachedWebGl2Result = false;

/**
 * Checks WebGL2 availability WITHOUT spending any CLI time — gates both the
 * "3D" toggle button's visibility (KStepCard.ts) and, before it, whether
 * `renderGlbViaCli`'s ~1.8s round trip is even worth starting (main.ts).
 * Deliberately free of any `three` import (unlike the actual mounting logic
 * in KStepViewer.ts) — a real `WebGLRenderingContext`/canvas capability
 * probe is plain DOM API, not GLB-data or three.js-specific logic, and
 * keeping it here means neither KStepCard.ts nor its unit tests need to pull
 * in the ~600 KB `three` dependency graph just to decide button visibility.
 *
 * Memoized against `document` (MAJOR finding, this wave's review): every
 * geometry card render calls this — including cache hits and re-renders
 * triggered by an unrelated note edit — so an un-memoized version spends a
 * *real* WebGL2 context per call, and Chromium (Obsidian's Electron
 * renderer) hard-caps simultaneous contexts per process (~16) and silently
 * evicts the OLDEST one, exactly the kind of blank-canvas failure
 * `ViewerRegistry` above exists to prevent for *mounted* viewers — a probe
 * context can starve a real one out just as well. `document` never changes
 * within one Obsidian session, so caching against its identity (rather than
 * a plain "already probed" flag) is what lets a test install a fresh fake
 * `document` per case (see test/helpers/fakeDom.mjs's `installFakeWebGl2`)
 * and still get a freshly-probed result, with no test-only reset hook
 * needed. The probe context itself is released immediately via
 * `WEBGL_lose_context` once the capability check is done — it is never kept
 * around or reused for actual rendering.
 */
export function hasWebGl2(): boolean {
  if (typeof document === "undefined") return false;
  if (document === cachedWebGl2Document) return cachedWebGl2Result;

  let result = false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    result = gl !== null && gl !== undefined;
    gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  } catch {
    result = false;
  }

  cachedWebGl2Document = document;
  cachedWebGl2Result = result;
  return result;
}

/** Anything an active viewer can be told to shut down through — see KStepViewer.ts's `mountViewer`. */
export interface ViewerHandle {
  close(): void;
}

/**
 * LRU bookkeeping for the set of currently-active (mounted) WebGL viewers,
 * deliberately free of any WebGL/`three` dependency so it is testable under
 * `node:test` with plain fake handles (see test/kstep-glb.test.mjs).
 *
 * Bounding the count matters because browsers impose a hard ceiling on
 * simultaneous WebGL contexts per page/process; beyond it, the browser
 * silently evicts the OLDEST context (per the WebGL spec's context-loss
 * behaviour), which looks exactly like a correctly-rendered-but-now-blank
 * canvas — no error, no visible signal that anything went wrong. Capping
 * active viewers at `max` (4, per this wave's design) and pro-actively
 * closing the least-recently-activated one ourselves, on our own terms
 * (falling back to its 2D poster, not a dead black canvas), avoids ever
 * hitting that silent browser-level eviction.
 *
 * The "falling back to its 2D poster" half of that promise needs the EVICTED
 * handle's own owner to find out it happened — closing the handle alone
 * (which is all `activate`'s return value lets a caller do) leaves that
 * owner's card stuck showing a blank, already-closed canvas forever (MAJOR
 * finding, this wave's review). `activate`'s optional `onEvicted` callback is
 * how an owner registers for that notification at the same time it registers
 * its handle.
 */
export class ViewerRegistry<H extends ViewerHandle = ViewerHandle> {
  private readonly max: number;
  private readonly active: H[] = [];
  private readonly onEvictedCallbacks = new Map<H, () => void>();

  constructor(max: number = 4) {
    this.max = max;
  }

  get size(): number {
    return this.active.length;
  }

  /**
   * Registers `handle` as active (most-recently-used). If it is already
   * registered, it is simply moved to most-recently-used — this does not
   * double-count it. Returns the handles that must now be closed (evicted,
   * oldest-first) to stay within `max` — the caller is responsible for
   * actually calling `.close()` on each of those (this method never calls
   * `.close()` itself, so a caller in a headless test can assert on the
   * returned array without a real handle needing a working `.close()`).
   *
   * `onEvicted`, if given, is stored against `handle` and invoked — with no
   * arguments, purely as a notification — for whichever *other*, previously-
   * active handle(s) end up evicted to stay within `max` when THIS call
   * pushes the active count over the limit (which may belong to a
   * completely different owner than the one calling `activate` right now —
   * see the eviction loop below, which fires each evicted handle's own
   * `onEvicted` at the moment it evicts it, i.e. within this very call, not
   * deferred to whatever future `activate()` call happens to be running when
   * it occurs). `onEvicted` is a notification for the evicted handle's OWN
   * owner to update its UI (e.g. fall back to a 2D poster) — it does not
   * replace the returned array, which is still how the caller finds every
   * handle it must itself `.close()`. Not invoked, and not re-registered,
   * when re-activating an already-active handle without passing `onEvicted`
   * again — pass it again on every call if the caller wants it to stay
   * registered.
   */
  activate(handle: H, onEvicted?: () => void): H[] {
    const existingIndex = this.active.indexOf(handle);
    if (existingIndex !== -1) {
      this.active.splice(existingIndex, 1);
    }
    this.active.push(handle);
    if (onEvicted) {
      this.onEvictedCallbacks.set(handle, onEvicted);
    } else {
      // Re-activating without an `onEvicted` this time drops any earlier
      // registration for this handle, rather than silently keeping it —
      // matching this method's own doc comment ("pass it again on every call
      // if the caller wants it to stay registered"). A no-op for a handle
      // that had no registration to begin with.
      this.onEvictedCallbacks.delete(handle);
    }

    const evicted: H[] = [];
    while (this.active.length > this.max) {
      const oldest = this.active.shift();
      if (oldest !== undefined) {
        evicted.push(oldest);
        const cb = this.onEvictedCallbacks.get(oldest);
        this.onEvictedCallbacks.delete(oldest);
        cb?.();
      }
    }
    return evicted;
  }

  /** Removes `handle` from the active set (and its `onEvicted` registration, if any), if present. Safe to call more than once. */
  release(handle: H): void {
    const index = this.active.indexOf(handle);
    if (index !== -1) this.active.splice(index, 1);
    this.onEvictedCallbacks.delete(handle);
  }
}
