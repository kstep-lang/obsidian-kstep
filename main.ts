import { MarkdownPostProcessorContext, MarkdownRenderChild, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, KStepSettings } from "./src/KStepSettings";
import { KStepSettingsTab } from "./src/KStepSettingsTab";
import { renderViaCli, renderGlbViaCli } from "./src/KStepCliRenderer";
import { RenderCache, ConcurrencyGate, cacheKey } from "./src/KStepScheduler";
import {
  renderGeometry,
  renderSummary,
  renderNotice,
  renderCliError,
  renderInvocationError,
} from "./src/KStepCard";
import { ViewerRegistry } from "./src/KStepGlb";
import type { Viewer3dHandle } from "./src/KStepViewer";
import { Kstep3dController } from "./src/Kstep3dController";

export default class KStepPlugin extends Plugin {
  settings!: KStepSettings;
  private cache = new RenderCache(32);
  private gate = new ConcurrencyGate(2);
  // Bounds simultaneously-mounted WebGL viewers across the whole plugin
  // (not per note) — see ViewerRegistry's own doc comment in KStepGlb.ts for
  // why a hard cap matters (silent browser-level context eviction).
  private viewerRegistry = new ViewerRegistry<Viewer3dHandle>(4);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new KStepSettingsTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor(
      "kstep",
      async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        await this.renderBlock(source.trim(), el, ctx);
      },
    );
  }

  /** Runs the second, GLB-format CLI call — only ever invoked on explicit user action (the 3D toggle), through the same concurrency gate as the initial SVG/text render. */
  async runGlb(source: string, cliPath: string): Promise<Awaited<ReturnType<typeof renderGlbViaCli>>> {
    return this.gate.run(() => renderGlbViaCli(source, cliPath));
  }

  /**
   * Registers `handle` as the most-recently-activated viewer; returns
   * handles the LRU cap requires closing now. `onEvicted`, if given, is
   * called later — with no arguments — if `handle` ITSELF is ever the one
   * evicted by some future call (see `ViewerRegistry.activate`'s own doc
   * comment); `Kstep3dController.open` uses it to fall back to the 2D poster
   * when that happens.
   */
  activateViewer(handle: Viewer3dHandle, onEvicted?: () => void): Viewer3dHandle[] {
    return this.viewerRegistry.activate(handle, onEvicted);
  }

  /** Removes `handle` from the active-viewer set (does not close it — the caller does that). */
  releaseViewer(handle: Viewer3dHandle): void {
    this.viewerRegistry.release(handle);
  }

  private async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): Promise<void> {
    if (!source) return;

    const container = el.createDiv({ cls: "kstep-block" });

    if (!Platform.isDesktopApp) {
      renderInvocationError(
        container,
        "kSTEP preview is desktop-only",
        "kstep-cli runs on the JVM and is not available on mobile.",
      );
      return;
    }

    // Read once and reuse for both the cache-key and the actual CLI call: a
    // block can sit queued behind the concurrency gate for a while, and if
    // the user changes the CLI-path setting while it waits, saveSettings()
    // clears the cache but a *second*, now-stale read here would still write
    // the eventual result back under a key nothing can look up again (built
    // from the old path) — a permanent dead entry in the small LRU cache.
    const cliPath = this.settings.cliPath;

    const key = cacheKey(cliPath, source);
    const cached = this.cache.get(key);
    if (cached) {
      this.paint(container, cached, source, cliPath, ctx);
      return;
    }

    const loading = container.createDiv({ cls: "kstep-loading" });
    loading.createDiv({ cls: "kstep-spinner" });
    loading.createSpan({ cls: "kstep-loading-text", text: "Running kSTEP script…" });

    // `renderViaCli` is documented as "never throws", but that contract
    // relies on `child_process.execFile` itself never throwing — and it DOES
    // throw synchronously (before registering a callback, so `renderViaCli`'s
    // own internal try/catch around that callback never runs) for a `cliPath`
    // that isn't a plausible path string, e.g. a NUL byte
    // (`ERR_INVALID_ARG_VALUE`) — verified against the real bundle. A
    // `cliPath` this malformed shouldn't reach here now that `loadSettings`
    // validates its type, but a future settings-tab change or an
    // Obsidian-Sync-merged value could still produce one. Without this
    // try/catch, that throw becomes an unhandled promise rejection: `loading`
    // is never removed, no error card is ever painted, and the "Running
    // kSTEP script…" spinner stays on screen forever with no indication of
    // why.
    let result: Awaited<ReturnType<typeof renderViaCli>>;
    try {
      result = await this.gate.run(() => renderViaCli(source, cliPath));
    } catch (e) {
      loading.remove();
      const msg = e instanceof Error ? e.message : String(e);
      renderInvocationError(container, "Could not run the kSTEP CLI", msg);
      return;
    }

    loading.remove();
    this.paint(container, result, source, cliPath, ctx);

    if (result.kind !== "invocationError") {
      this.cache.set(key, result);
    }
  }

  // Both call sites (the cache-hit path and the fresh-render path) invoke
  // this synchronously and do not themselves sit inside a try/catch, so a
  // throw from any of the render* functions below — e.g. renderGeometry
  // dereferencing something unsanitised-away — would otherwise escape as an
  // unhandled promise rejection out of `renderBlock`, leaving the block
  // permanently empty with no error card. Catch here, once, for every
  // result kind rather than duplicating the guard at each call site.
  private paint(
    container: HTMLElement,
    result: Awaited<ReturnType<typeof renderViaCli>>,
    source: string,
    cliPath: string,
    ctx: MarkdownPostProcessorContext,
  ): void {
    try {
      switch (result.kind) {
        case "geometry": {
          const controller = new Kstep3dController(this, source, cliPath);
          let childRegistered = false;
          renderGeometry(container, result.svg, result.json, (host, poster, resetToPoster) => {
            if (!childRegistered) {
              childRegistered = true;
              // `MarkdownRenderChild`'s own unload detection watches
              // `host` (its `containerEl`) leaving the document — exactly
              // the DOM subtree this card's viewer lives in.
              const child = new MarkdownRenderChild(host);
              child.onunload = () => controller.dispose();
              ctx.addChild(child);
            }
            void controller.open(host, poster, resetToPoster);
          });
          break;
        }
        case "summary":
          renderSummary(container, result.text);
          break;
        case "notice":
          renderNotice(container, result.text, result.json);
          break;
        case "cliError":
          renderCliError(container, result.json);
          break;
        case "invocationError":
          renderInvocationError(container, result.title, result.detail);
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      renderInvocationError(container, "Could not render the kSTEP preview", msg);
    }
  }

  async loadSettings(): Promise<void> {
    // `Plugin.loadData()` is declared `Promise<any>` in the Obsidian types —
    // that's only a compile-time assertion, not a runtime check. data.json is
    // arbitrary JSON (hand-edited, corrupted, or merged by Obsidian Sync
    // across devices with different plugin versions), so `persisted.cliPath`
    // being present is no guarantee it's a string. `renderViaCli` passes
    // `cliPath` straight into `child_process.execFile`, which throws
    // SYNCHRONOUSLY (before registering its callback, so the defensive
    // try/catch inside that callback never runs) on a non-string value —
    // verified against the real bundle: `execFile(source, 123, ...)` and
    // `execFile(source, null, ...)` both throw `ERR_INVALID_ARG_TYPE`
    // immediately. Left unvalidated, that throw would escape `renderBlock`
    // in `onload` below, and — absent the try/catch added there — leave the
    // block's spinner on screen forever. Validating here, at the one place
    // untrusted persisted data enters the plugin, keeps `this.settings.cliPath`
    // a guaranteed `string` everywhere else in the codebase.
    const persisted = (await this.loadData()) as Partial<KStepSettings> | null;
    const validated: Partial<KStepSettings> =
      typeof persisted?.cliPath === "string" ? { cliPath: persisted.cliPath } : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, validated);
  }

  async saveSettings(): Promise<void> {
    // Settings changes (notably cliPath) invalidate every cached result.
    this.cache.clear();
    await this.saveData(this.settings);
  }
}
