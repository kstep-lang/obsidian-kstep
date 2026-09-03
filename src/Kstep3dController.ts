import type { KStepGlbResult } from "./KStepResult";
import { validateGlb, shouldOfferViewer } from "./KStepGlb";
import { renderViewerError } from "./KStepCard";
import { mountViewer, type Viewer3dHandle, type ViewerMountResult } from "./KStepViewer";

/** The shape of `mountViewer` itself — see the constructor's `mount` parameter below. */
type MountViewerFn = (
  host: HTMLElement,
  glb: ArrayBuffer,
  onAsyncError?: (reason: string) => void,
) => ViewerMountResult;

/**
 * Deliberately free of any `obsidian` import (unlike `main.ts`, where this
 * class used to live) — the `obsidian` package ships only ambient type
 * declarations, no runtime JS (see its own `package.json`), so anything that
 * imports it cannot be bundled and `require()`d headlessly the way
 * test/helpers/loadModule.mjs does for every other module under test. Moving
 * this class out here (MAJOR testability finding, this wave's review) is what
 * makes test/kstep-3d-controller.test.mjs possible at all — before this move,
 * `Kstep3dController` had zero unit tests because it could not be loaded
 * outside a real Obsidian/Electron runtime.
 *
 * Consequently, `Kstep3dController` depends on `KStepPlugin` (main.ts) only
 * through the narrow `Kstep3dHostPlugin` interface below, not the concrete
 * class — `main.ts`'s `KStepPlugin` satisfies it structurally, no explicit
 * `implements` needed, and a test can hand it a plain fake instead.
 */
export interface Kstep3dHostPlugin {
  runGlb(source: string, cliPath: string): Promise<KStepGlbResult>;
  activateViewer(handle: Viewer3dHandle, onEvicted?: () => void): Viewer3dHandle[];
  releaseViewer(handle: Viewer3dHandle): void;
}

/**
 * Owns the whole "click 3D, mount a viewer" lifecycle for exactly ONE
 * geometry card. Created once per card render (in `KStepPlugin.paint`'s
 * `"geometry"` case) and reused across repeated toggle clicks — so a
 * 3D→2D→3D cycle after the first successful mount costs neither a second CLI
 * call nor a second `GLTFLoader.parse` (see the implementation report's
 * §3.5/§4.7: the GLB buffer lives here, at the block/card level, not in the
 * plugin-wide `RenderCache`, and its lifetime ends exactly when this card's
 * `MarkdownRenderChild` unloads).
 */
export class Kstep3dController {
  private glbBuffer: ArrayBuffer | undefined;
  private handle: Viewer3dHandle | undefined;
  private opening = false;
  // Set the first time `open()` successfully wires the zoom-in/zoom-out/reset
  // buttons to a mounted handle, and never unset — guards against
  // re-registering another `click` listener on every subsequent successful
  // mount (MAJOR regression, this wave's review). `host.parentElement` and
  // its three control buttons are the same DOM nodes for this card's entire
  // lifetime (KStepCard.ts's `renderViewerToggle` builds them once and only
  // toggles `hidden`/visibility on repeated 3D/2D switches — see that
  // function), so wiring them exactly once per controller instance is
  // correct: nothing here ever needs re-finding or re-binding on a later
  // mount (fresh mount after LRU eviction, or a retry after a failed one) —
  // only `this.handle` itself changes, and every listener already closes
  // over `this.handle` freshly on each click rather than the handle that was
  // live at wiring time.
  private buttonsWired = false;
  // Set once, from `dispose()`, and never unset — `dispose()` is this card's
  // MarkdownRenderChild.onunload, a one-way, one-time transition (see that
  // method below). Guards against the race described next to its checks in
  // `open()`.
  private disposed = false;

  constructor(
    private readonly plugin: Kstep3dHostPlugin,
    private readonly source: string,
    private readonly cliPath: string,
    // Defaults to the real `mountViewer` (three.js/WebGL) in production.
    // Overridable so test/kstep-3d-controller.test.mjs can exercise this
    // class's own orchestration logic — the CLI-await race, the LRU-eviction
    // fallback, the async-parse-error retry path, the error-card stacking fix
    // — with a synchronous fake handle, instead of needing a real WebGL2
    // context (unavailable under plain `node:test`) just to get past this
    // one call (MAJOR testability finding, this wave's review). KStepViewer.ts
    // itself stays untested, deliberately (see this file's own header
    // comment) — this parameter tests everything AROUND that one call, not
    // the call's own real implementation.
    private readonly mount: MountViewerFn = mountViewer,
  ) {}

  /**
   * Called by KStepCard.ts's toggle button every time it switches INTO 3D
   * mode. A no-op if a viewer is already mounted (poster↔viewer visibility
   * is KStepCard's own concern), if a previous call is still in flight
   * (guards a rapid double-click from starting two overlapping CLI calls for
   * the same card), or if this card has already been disposed.
   *
   * `resetToPoster` is KStepCard.ts's own toggle-reset closure (see
   * `renderGeometry`'s doc comment) — stashed here so the plugin-wide
   * `ViewerRegistry` LRU eviction callback below can call it later, from
   * OUTSIDE this method's call stack, without KStepCard.ts needing to know
   * anything about eviction itself.
   */
  async open(host: HTMLElement, poster: HTMLElement, resetToPoster: () => void): Promise<void> {
    if (this.handle || this.opening || this.disposed) return;
    this.opening = true;
    // Clear whatever this same host is still showing from a PREVIOUS failed
    // attempt (an error card from an earlier invocationError/mount failure)
    // before starting a new one — otherwise every retry stacks another error
    // box under the last instead of replacing it (MINOR finding, this wave's
    // review). `renderViewerError` below also clears `host` itself, as a
    // second line of defence for the async-parse-failure path, which doesn't
    // go through this top-of-`open()` clear at all.
    host.empty();
    try {
      if (!this.glbBuffer) {
        const result = await this.plugin.runGlb(this.source, this.cliPath);
        // `dispose()` (this card's MarkdownRenderChild.onunload) can fire
        // while this ~1.8s CLI call is in flight — `host` may already be
        // detached from the document by the time we get here (MAJOR finding,
        // this wave's review). Stop now, before ever touching `host` again or
        // mounting a real WebGL context into it: there is nothing left to
        // clean up, since nothing below this point has run yet.
        if (this.disposed) return;
        if (result.kind === "invocationError") {
          renderViewerError(host, result.title, result.detail);
          return;
        }
        if (!shouldOfferViewer(result.json)) {
          renderViewerError(
            host,
            "No 3D geometry",
            "The 3D render produced no usable triangles for this model.",
          );
          return;
        }
        const validation = validateGlb(result.glb, result.json.glb?.byteLength);
        if (!validation.ok) {
          renderViewerError(host, "The kSTEP CLI produced an invalid 3D model", validation.reason);
          return;
        }
        this.glbBuffer = result.glb;
      }

      // Set by the `onAsyncError` callback below ONLY when `GLTFLoader.parse`
      // fails SYNCHRONOUSLY — before `this.mount(...)` has even returned
      // (three.js does this in two places: a malformed BIN chunk throws
      // inside `GLTFBinaryExtension`'s constructor, and a missing/unsupported
      // `asset.version` is checked directly in `parse()` — see
      // KStepGlb.ts's `findMissingOrUnsupportedAssetVersion`, added this wave
      // as a belt-and-suspenders guard against the same two cases). At the
      // point this callback can fire synchronously, `this.handle` is still
      // whatever it was before this call started (`open()`'s own top-of-
      // function guard means that's always `undefined` here — a re-entrant
      // or already-mounted call never reaches this point at all), so it
      // cannot be used to close the dead handle from inside the callback the
      // way the truly-async, post-return branch below does. Stash the reason
      // instead and let the code right after `this.mount(...)` react, once
      // `mountResult` actually holds the handle worth closing (MINOR finding,
      // this wave's review).
      let syncMountFailure: string | undefined;
      const mountResult = this.mount(host, this.glbBuffer, (reason) => {
        // Skip entirely if this card was disposed in the meantime — `host`
        // may no longer be attached to anything worth painting an error
        // into, and `dispose()` already closed whatever handle existed.
        if (this.disposed) return;
        if (this.handle) {
          // GLTFLoader.parse failed asynchronously, well after `mountViewer`
          // itself returned — `this.handle` is the very handle this failed
          // mount produced: a live WebGL context with nothing useful in it,
          // forever. Close it and clear `this.handle` so the NEXT 3D click
          // gets a real retry instead of returning immediately at the
          // `this.handle` guard above with no way out (MINOR finding, this
          // wave's review).
          this.plugin.releaseViewer(this.handle);
          this.handle.close();
          this.handle = undefined;
          renderViewerError(host, "Could not display the 3D model", reason);
        } else {
          // The synchronous case described above — nothing to close yet.
          syncMountFailure = reason;
        }
      });
      if (!mountResult.ok) {
        renderViewerError(host, "Could not display the 3D model", mountResult.reason);
        return;
      }
      if (syncMountFailure !== undefined) {
        // `this.mount(...)` itself succeeded (a real WebGL renderer/canvas
        // got created), but `onAsyncError` already fired before it returned —
        // the handle it just gave us is dead on arrival. Close it now, before
        // it is ever assigned to `this.handle`, registered with
        // `activateViewer`, or wired to the control buttons below — leaving
        // it live would leak a WebGL context under a `this.handle` that stays
        // `undefined` forever, with no way for a later click to find and
        // close it (MINOR finding, this wave's review).
        mountResult.handle.close();
        renderViewerError(host, "Could not display the 3D model", syncMountFailure);
        return;
      }

      this.handle = mountResult.handle;
      if (!this.buttonsWired) {
        // Wire the three visible control buttons KStepCard.ts already built —
        // this module is the one place allowed to know about Viewer3dHandle
        // (KStepCard.ts itself stays free of the `three`-importing
        // KStepViewer.ts, see that file's header comment). Done exactly once
        // per controller instance (see `buttonsWired`'s own doc comment
        // above) — every listener below reads `this.handle` fresh on each
        // click, so it keeps working correctly across a later re-mount
        // (eviction fallback, or a retry after a failed attempt) without
        // ever needing to be re-registered.
        this.buttonsWired = true;
        const zoomIn = host.parentElement?.querySelector<HTMLButtonElement>(".kstep-3d-zoom-in");
        const zoomOut = host.parentElement?.querySelector<HTMLButtonElement>(".kstep-3d-zoom-out");
        const reset = host.parentElement?.querySelector<HTMLButtonElement>(".kstep-3d-reset");
        zoomIn?.addEventListener("click", () => this.handle?.zoomIn());
        zoomOut?.addEventListener("click", () => this.handle?.zoomOut());
        reset?.addEventListener("click", () => this.handle?.resetView());
      }

      const evicted = this.plugin.activateViewer(this.handle, () => {
        // Fires later, possibly long after this `open()` call has returned,
        // when the plugin-wide LRU cap evicts THIS card's handle to make room
        // for some other card's (MAJOR finding, this wave's review). The
        // evicted handle itself is closed by the OTHER card's own
        // `activateViewer` caller (the `evicted.forEach`/loop pattern below,
        // over there) — this callback's only job is this card's own
        // bookkeeping and UI: forget the now-closed handle and fall back to
        // the 2D poster, rather than leaving this card showing a blank,
        // already-closed canvas with its toggle still stuck on "2D".
        this.handle = undefined;
        resetToPoster();
      });
      for (const old of evicted) old.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      renderViewerError(host, "Could not display the 3D model", msg);
    } finally {
      this.opening = false;
    }
  }

  /** Called once, from this card's `MarkdownRenderChild.onunload`. */
  dispose(): void {
    this.disposed = true;
    if (this.handle) {
      this.plugin.releaseViewer(this.handle);
      this.handle.close();
      this.handle = undefined;
    }
  }
}
