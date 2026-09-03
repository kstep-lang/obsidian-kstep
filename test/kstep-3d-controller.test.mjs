import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers/loadModule.mjs";
import { FakeElement } from "./helpers/fakeDom.mjs";

// Covers src/Kstep3dController.ts — until this wave's review, this class had
// zero unit tests (MAJOR testability finding), because it used to live in
// main.ts, which imports the real `obsidian` package (types-only, no runtime
// JS — see main.ts's own comment on why that made headless bundling
// impossible). It has since been extracted into its own `obsidian`-free
// module for exactly this reason. `mountViewer` (KStepViewer.ts, the one
// module that DOES import `three`) is injected via the controller's
// constructor rather than exercised for real — see Kstep3dController.ts's
// own doc comment on that parameter for why (no real WebGL2 context exists
// under plain `node:test`), and KStepViewer.ts's own header comment for why
// that module itself staying untested is a deliberate, accepted gap.

const { Kstep3dController } = await loadModule("src/Kstep3dController.ts");

// ── GLB fixture builder — mirrors test/kstep-glb.test.mjs's own `buildGlb`,
// duplicated here rather than shared because it is a handful of lines and
// each file's fixtures serve a different purpose (validateGlb's own
// container-format tests there vs. Kstep3dController's pipeline tests here).

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;

function buildGlb(jsonObj = { asset: { version: "2.0" } }) {
  const jsonText = JSON.stringify(jsonObj);
  const jsonRaw = Buffer.from(jsonText, "utf8");
  const pad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBytes = Buffer.concat([jsonRaw, Buffer.alloc(pad, 0x20)]);
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

function successGlbResult({ triangleCount = 12 } = {}) {
  const glb = buildGlb();
  return {
    kind: "geometry3d",
    glb,
    json: {
      status: "success",
      command: "render",
      outPath: "/tmp/out",
      format: "glb",
      content: "geometry",
      fallback: false,
      geometry: { detected: true, shapeCount: 1 },
      occt: { available: true, version: "fake" },
      rootCount: 1,
      glb: { triangleCount, vertexCount: 0, droppedTriangleCount: 0, byteLength: glb.byteLength },
    },
  };
}

function invocationErrorResult(title = "kSTEP CLI not found", detail = "detail text") {
  return { kind: "invocationError", title, detail };
}

function fakeHandle() {
  return {
    closed: false,
    zoomInCalls: 0,
    zoomOutCalls: 0,
    resetCalls: 0,
    zoomIn() {
      this.zoomInCalls++;
    },
    zoomOut() {
      this.zoomOutCalls++;
    },
    resetView() {
      this.resetCalls++;
    },
    close() {
      this.closed = true;
    },
  };
}

/** Builds the same host/poster/controls DOM shape KStepCard.ts's `renderViewerToggle` builds, using FakeElement. */
function makeCard() {
  const wrap = new FakeElement("div");
  const host = wrap.createDiv({ cls: "kstep-viewer" });
  const poster = wrap.createDiv({ cls: "kstep-plate" });
  const controls = wrap.createDiv({ cls: "kstep-3d-controls" });
  const zoomIn = controls.createEl("button", { cls: "kstep-3d-zoom-in" });
  const zoomOut = controls.createEl("button", { cls: "kstep-3d-zoom-out" });
  const reset = controls.createEl("button", { cls: "kstep-3d-reset" });
  return { wrap, host, poster, zoomIn, zoomOut, reset };
}

/** Fake Kstep3dHostPlugin — records activate/release calls; `runGlb` is supplied per test. */
function makePlugin(runGlb) {
  const activateCalls = [];
  const releaseCalls = [];
  return {
    runGlb,
    activateViewer(handle, onEvicted) {
      activateCalls.push({ handle, onEvicted });
      return [];
    },
    releaseViewer(handle) {
      releaseCalls.push(handle);
    },
    activateCalls,
    releaseCalls,
  };
}

// ── Re-entrancy / guard flags ────────────────────────────────────────────

test("open(): a concurrent call while the CLI round trip is in flight does not start a second one", async () => {
  let runGlbCalls = 0;
  let resolveRunGlb;
  const runGlb = () =>
    new Promise((resolve) => {
      runGlbCalls++;
      resolveRunGlb = resolve;
    });
  const plugin = makePlugin(runGlb);
  const controller = new Kstep3dController(plugin, "source", "/bin/kstep-cli", () => ({
    ok: false,
    reason: "unused",
  }));
  const { host, poster } = makeCard();

  const first = controller.open(host, poster, () => {});
  const second = controller.open(host, poster, () => {}); // must be a no-op — `opening` is already true

  resolveRunGlb(invocationErrorResult());
  await first;
  await second;

  assert.equal(runGlbCalls, 1, "a concurrent open() call must not start a second CLI round trip");
});

test("open(): a no-op once the card has already been disposed", async () => {
  let runGlbCalls = 0;
  const runGlb = async () => {
    runGlbCalls++;
    return invocationErrorResult();
  };
  const plugin = makePlugin(runGlb);
  const controller = new Kstep3dController(plugin, "source", "/bin/kstep-cli", () => ({
    ok: false,
    reason: "unused",
  }));
  const { host, poster } = makeCard();

  controller.dispose();
  await controller.open(host, poster, () => {});

  assert.equal(runGlbCalls, 0, "open() must not run the CLI at all once disposed");
});

// ── MAJOR regression: dispose() during the in-flight CLI call ──────────────

test("open(): dispose() during the in-flight CLI call prevents any mount and paints nothing (MAJOR regression — dispose-during-open race)", async () => {
  let resolveRunGlb;
  const runGlb = () => new Promise((resolve) => (resolveRunGlb = resolve));
  let mountCalls = 0;
  const mount = () => {
    mountCalls++;
    return { ok: true, handle: fakeHandle() };
  };
  const plugin = makePlugin(runGlb);
  const controller = new Kstep3dController(plugin, "source", "/bin/kstep-cli", mount);
  const { host, poster } = makeCard();

  const openPromise = controller.open(host, poster, () => {});
  controller.dispose(); // the card's MarkdownRenderChild unloads while the ~1.8s CLI call is still in flight
  resolveRunGlb(successGlbResult());
  await openPromise;

  assert.equal(mountCalls, 0, "must never mount a WebGL viewer into a host whose card was already disposed");
  assert.equal(host.children.length, 0, "must not paint any error card into a disposed card's host either");
  assert.equal(plugin.activateCalls.length, 0);
});

// ── CLI-result branches, all painting an error and staying retryable ──────

test("open(): a CLI invocationError paints the error and the retry replaces it instead of stacking (MINOR regression)", async () => {
  let runGlbCalls = 0;
  const runGlb = async () => {
    runGlbCalls++;
    return invocationErrorResult("kSTEP CLI not found", "Set the path in Settings.");
  };
  const plugin = makePlugin(runGlb);
  const controller = new Kstep3dController(plugin, "source", "/bin/kstep-cli", () => ({
    ok: false,
    reason: "unused",
  }));
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});
  assert.equal(host.queryAllByClass("kstep-error-title").length, 1);
  assert.ok(host.allText().includes("kSTEP CLI not found"));
  assert.ok(host.allText().includes("Set the path in Settings."));

  await controller.open(host, poster, () => {}); // a second 3D click after the failure

  assert.equal(runGlbCalls, 2, "a failed attempt must not cache a bad result — the retry re-runs the CLI");
  assert.equal(
    host.queryAllByClass("kstep-error-title").length,
    1,
    "the retry's error card must replace the previous one, not stack under it",
  );
});

test("open(): a GLB with zero usable triangles shows \"No 3D geometry\" instead of mounting", async () => {
  const runGlb = async () => successGlbResult({ triangleCount: 0 });
  const plugin = makePlugin(runGlb);
  let mountCalls = 0;
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => {
    mountCalls++;
    return { ok: true, handle: fakeHandle() };
  });
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});

  assert.equal(mountCalls, 0);
  assert.ok(host.allText().includes("No 3D geometry"));
});

test("open(): a GLB that fails validateGlb (too short to be a real container) is rejected before ever mounting", async () => {
  const tooShort = new Uint8Array([1, 2, 3]).buffer;
  const runGlb = async () => ({
    kind: "geometry3d",
    glb: tooShort,
    json: {
      status: "success",
      command: "render",
      outPath: "/tmp/out",
      format: "glb",
      content: "geometry",
      fallback: false,
      geometry: { detected: true, shapeCount: 1 },
      occt: { available: true, version: "fake" },
      rootCount: 1,
      glb: { triangleCount: 12, vertexCount: 0, droppedTriangleCount: 0, byteLength: 3 },
    },
  });
  const plugin = makePlugin(runGlb);
  let mountCalls = 0;
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => {
    mountCalls++;
    return { ok: true, handle: fakeHandle() };
  });
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});

  assert.equal(mountCalls, 0);
  assert.ok(host.allText().includes("invalid 3D model"));
});

test("open(): a synchronous mount failure shows an error and is retryable without a second CLI call", async () => {
  let runGlbCalls = 0;
  const runGlb = async () => {
    runGlbCalls++;
    return successGlbResult();
  };
  const plugin = makePlugin(runGlb);
  let mountCalls = 0;
  const mount = () => {
    mountCalls++;
    return { ok: false, reason: "Could not create a WebGL renderer: boom" };
  };
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});
  assert.ok(host.allText().includes("boom"));

  await controller.open(host, poster, () => {}); // retry

  assert.equal(
    runGlbCalls,
    1,
    "the GLB buffer was already fetched and validated on the first attempt — a mount-only retry must not re-run the CLI",
  );
  assert.equal(mountCalls, 2);
  assert.equal(
    host.queryAllByClass("kstep-error-title").length,
    1,
    "the retry's error card must replace the previous one, not stack under it",
  );
});

test("open(): an unexpected thrown error is caught and rendered, not left as an unhandled rejection", async () => {
  const plugin = makePlugin(async () => {
    throw new Error("kaboom");
  });
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => ({ ok: false, reason: "unused" }));
  const { host, poster } = makeCard();

  await assert.doesNotReject(() => controller.open(host, poster, () => {}));
  assert.ok(host.allText().includes("kaboom"));
});

// ── Successful mount: control-button wiring + LRU registration ────────────

test("open(): a successful mount wires the zoom/reset buttons to the mounted handle and registers it with activateViewer", async () => {
  const handle = fakeHandle();
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => ({ ok: true, handle }));
  const { host, poster, zoomIn, zoomOut, reset } = makeCard();

  await controller.open(host, poster, () => {});

  zoomIn.dispatch("click");
  zoomOut.dispatch("click");
  reset.dispatch("click");

  assert.equal(handle.zoomInCalls, 1);
  assert.equal(handle.zoomOutCalls, 1);
  assert.equal(handle.resetCalls, 1);
  assert.equal(plugin.activateCalls.length, 1);
  assert.equal(plugin.activateCalls[0].handle, handle);
});

test("open(): re-mounting after an eviction fallback does not add a second click listener to the control buttons (MAJOR regression — double-firing zoom)", async () => {
  const handles = [];
  const plugin = makePlugin(async () => successGlbResult());
  const mount = () => {
    const handle = fakeHandle();
    handles.push(handle);
    return { ok: true, handle };
  };
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster, zoomIn } = makeCard();

  await controller.open(host, poster, () => {});
  assert.equal(zoomIn.listeners.click?.length, 1, "expected exactly one click listener after the first mount");

  // Simulate the plugin-wide LRU cap evicting THIS card's handle, then a
  // fresh 3D click re-mounting it — the exact sequence this wave's fixes
  // (eviction fallback + retryable async-parse-error) made reachable for the
  // first time.
  const { onEvicted } = plugin.activateCalls[0];
  onEvicted();
  await controller.open(host, poster, () => {});

  assert.equal(handles.length, 2, "expected a second, real mount after the eviction fallback");
  assert.equal(
    zoomIn.listeners.click?.length,
    1,
    "a second successful mount must not register a second click listener on the same button",
  );

  zoomIn.dispatch("click");

  assert.equal(handles[0].zoomInCalls, 0, "the FIRST (evicted, now-stale) handle must never be called again");
  assert.equal(handles[1].zoomInCalls, 1, "a single click must call zoomIn on the current handle exactly once");
});

test("open(): a handle evicted by this call's own activateViewer is closed", async () => {
  const evictedHandle = fakeHandle();
  const plugin = makePlugin(async () => successGlbResult());
  plugin.activateViewer = (handle, onEvicted) => {
    plugin.activateCalls.push({ handle, onEvicted });
    return [evictedHandle];
  };
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => ({ ok: true, handle: fakeHandle() }));
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});

  assert.equal(evictedHandle.closed, true);
});

// ── MAJOR regression: this card's OWN handle being evicted later ──────────

test("open(): being evicted later (plugin-wide LRU cap) resets the controller and falls back to the 2D poster, and the card stays retryable", async () => {
  let runGlbCalls = 0;
  const plugin = makePlugin(async () => {
    runGlbCalls++;
    return successGlbResult();
  });
  let mountCalls = 0;
  const mount = () => {
    mountCalls++;
    return { ok: true, handle: fakeHandle() };
  };
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster } = makeCard();
  let resetCalls = 0;
  const resetToPoster = () => resetCalls++;

  await controller.open(host, poster, resetToPoster);
  assert.equal(plugin.activateCalls.length, 1);
  const { onEvicted } = plugin.activateCalls[0];
  assert.equal(typeof onEvicted, "function");

  // Simulate the registry evicting THIS card's handle later, from some other
  // card's activate() call — not from anything this test calls directly on
  // `controller`.
  onEvicted();
  assert.equal(resetCalls, 1, "expected the card to fall back to its 2D poster on eviction");

  // And the card must be retryable afterwards: a fresh 3D click re-mounts
  // rather than returning immediately at the `this.handle` guard forever
  // (which would happen if `this.handle` still pointed at the closed handle).
  await controller.open(host, poster, resetToPoster);
  assert.equal(mountCalls, 2, "expected a second mount attempt after eviction");
  assert.equal(runGlbCalls, 1, "the cached GLB buffer must be reused — eviction is not a CLI-level failure");
});

// ── MINOR regression: async GLTFLoader.parse failure (onAsyncError) ───────

test("open(): an async parse failure (onAsyncError) closes the dead handle, shows an error, and makes the card retryable", async () => {
  const handle = fakeHandle();
  let capturedOnAsyncError;
  let mountCalls = 0;
  const mount = (_host, _glb, onAsyncError) => {
    mountCalls++;
    capturedOnAsyncError = onAsyncError;
    return { ok: true, handle };
  };
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});
  assert.equal(typeof capturedOnAsyncError, "function");

  capturedOnAsyncError("GLTFLoader.parse failed: bad accessor");

  assert.equal(handle.closed, true);
  assert.deepEqual(plugin.releaseCalls, [handle]);
  assert.ok(host.allText().includes("Could not display the 3D model"));
  assert.ok(host.allText().includes("GLTFLoader.parse failed: bad accessor"));

  // Retryable: a second open() call must attempt to mount again — before this
  // wave's fix, `this.handle` still pointed at the closed-but-never-cleared
  // handle and every subsequent click returned immediately at the guard.
  await controller.open(host, poster, () => {});
  assert.equal(mountCalls, 2);
});

test("open(): an onAsyncError that fires SYNCHRONOUSLY, before mount() returns, closes the dead handle instead of leaking it (MINOR regression — three.js fires onError synchronously for a bad BIN chunk or a missing/unsupported asset.version)", async () => {
  const deadHandles = [];
  let mountCalls = 0;
  const mount = (_host, _glb, onAsyncError) => {
    mountCalls++;
    const handle = fakeHandle();
    deadHandles.push(handle);
    // Mirrors GLTFLoader.parse's own two synchronous-onError branches
    // (GLTFBinaryExtension's constructor; the `asset.version` check) — the
    // callback fires HERE, before `mount` itself has returned, so
    // `Kstep3dController` cannot yet have assigned `this.handle`.
    onAsyncError("bad BIN chunk header");
    return { ok: true, handle };
  };
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});

  assert.equal(deadHandles[0].closed, true, "the handle mount() produced must be closed, not leaked");
  assert.equal(plugin.activateCalls.length, 0, "a dead-on-arrival handle must never reach activateViewer");
  assert.ok(host.allText().includes("Could not display the 3D model"));
  assert.ok(host.allText().includes("bad BIN chunk header"));

  // Retryable, exactly like the async-after-return case below: a second 3D
  // click must attempt a real mount again, not return immediately at a
  // `this.handle` guard pointing at nothing (or at a handle that was never
  // actually usable).
  await controller.open(host, poster, () => {});
  assert.equal(mountCalls, 2);
});

test("open(): an async parse failure that fires after dispose() does not repaint into a torn-down host", async () => {
  const handle = fakeHandle();
  let capturedOnAsyncError;
  const mount = (_host, _glb, onAsyncError) => {
    capturedOnAsyncError = onAsyncError;
    return { ok: true, handle };
  };
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", mount);
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});
  controller.dispose(); // closes `handle` and releases it already
  handle.closed = false; // reset the spy so a REDUNDANT second close from onAsyncError would be visible
  plugin.releaseCalls.length = 0;
  host.empty(); // mirrors the real DOM: the card's whole subtree is gone by now

  capturedOnAsyncError("late failure, well after the card was torn down");

  assert.equal(handle.closed, false, "must not act on a handle belonging to an already-disposed card");
  assert.deepEqual(plugin.releaseCalls, []);
  assert.equal(host.children.length, 0, "must not paint an error card into a torn-down host");
});

// ── dispose() ────────────────────────────────────────────────────────────

test("dispose(): releases and closes an active handle, and is safe to call more than once", async () => {
  const handle = fakeHandle();
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => ({ ok: true, handle }));
  const { host, poster } = makeCard();

  await controller.open(host, poster, () => {});

  controller.dispose();
  assert.equal(handle.closed, true);
  assert.deepEqual(plugin.releaseCalls, [handle]);

  handle.closed = false; // reset the spy so a redundant second close would be visible
  plugin.releaseCalls.length = 0;
  controller.dispose(); // second call — must be a no-op

  assert.equal(handle.closed, false);
  assert.deepEqual(plugin.releaseCalls, []);
});

test("dispose(): with no handle mounted yet is a no-op beyond marking the card disposed", () => {
  const plugin = makePlugin(async () => successGlbResult());
  const controller = new Kstep3dController(plugin, "s", "/bin/x", () => ({ ok: true, handle: fakeHandle() }));

  assert.doesNotThrow(() => controller.dispose());
  assert.deepEqual(plugin.releaseCalls, []);
});
