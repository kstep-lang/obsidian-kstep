import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ViewerHandle } from "./KStepGlb";

/**
 * The ONLY module in this plugin that imports `three` (design-team decision,
 * see this wave's implementation report §1) — every other module reasoning
 * about GLB data (KStepGlb.ts, KStepCliRenderer.ts) stays free of it so it
 * can be exercised under plain `node:test` without a WebGL context.
 *
 * Deliberately restricted imports: `three` core, `GLTFLoader`, and
 * `OrbitControls` — nothing else. In particular, never `DRACOLoader`,
 * `KTX2Loader`, `LottieLoader`, `RoomEnvironment`, `setDecoderPath`/
 * `setTranscoderPath`, or `TextureLoader` (see the report's §1 "Verboten im
 * Code" list — every one of those either pulls in a fetch-capable loader or
 * a Google/jsDelivr-hosted decoder, and a kSTEP model preview needs none of
 * them: it has geometry and vertex normals, no textures, no compression).
 */

/** Diagonal isometric viewing direction — same visual convention as the SVG poster. */
const VIEW_DIRECTION = new Vector3(1, 1, 1).normalize();
/** sin(22.5°) — see the distance formula in `frameCamera` below. */
const HALF_FOV_SIN = Math.sin((22.5 * Math.PI) / 180);
const DOLLY_FACTOR = 1.1;
const MIN_RADIUS_FALLBACK = 1;

export interface Viewer3dHandle extends ViewerHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
}

export type ViewerMountResult = { ok: true; handle: Viewer3dHandle } | { ok: false; reason: string };

/**
 * Parses `glb` (already passed through `validateGlb` — see KStepGlb.ts) and
 * mounts a live three.js viewer into `host`. Returns synchronously: the
 * canvas, renderer, camera, and controls are all created and attached to
 * `host` before this function returns, but the model itself only appears
 * once `GLTFLoader.parse`'s `onLoad` callback fires (its promise-based
 * internals never resolve synchronously, even for fully self-contained,
 * already-in-memory binary data with no external references — see this
 * wave's report §1 for why `validateGlb`'s URI guard makes that "no external
 * references" property actually true here). A parse failure is reported
 * through `onAsyncError` — not the return value, since it fires after this
 * function has already returned — rather than left as a silently empty
 * canvas.
 *
 * `parse(arrayBuffer, "", onLoad, onError)` — an empty resolution `path` is
 * deliberate and is what makes the "never a Blob/ObjectURL/src attribute"
 * security property hold (see the report's §5.2): nothing here ever calls
 * `URL.createObjectURL`, and the loader never receives a filesystem or HTTP
 * path to resolve a relative reference against in the first place.
 */
export function mountViewer(
  host: HTMLElement,
  glb: ArrayBuffer,
  onAsyncError?: (reason: string) => void,
): ViewerMountResult {
  let renderer: WebGLRenderer;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
    // preserveDrawingBuffer: true matters here because this viewer has NO
    // continuous requestAnimationFrame loop — render() only runs reactively
    // (on load, resize, or an OrbitControls "change" event). Per the WebGL
    // spec, without this flag the browser is permitted to clear the drawing
    // buffer after compositing any frame where no new draw call has occurred
    // since, which can make a static three.js canvas go blank between
    // repaints with no error and no code-visible signal that anything went
    // wrong.
    //
    // Verified concretely, but NOT inside Obsidian itself (2026-09-06):
    // this exact renderer construction was ported near-verbatim to kstep.dev's
    // playground (kstep-lang/kstep.dev commit 29e5565's src/lib/kstepViewer.ts),
    // and reproduced there under Chromium — a `gl.readPixels()` taken in the
    // same script turn as a successful render showed real shaded geometry,
    // but a plain screenshot taken any time afterward (a separate macrotask,
    // what an actual viewer sees) showed a blank canvas, because the drawing
    // buffer had already been cleared in between. Obsidian's renderer process
    // is itself Chromium (Electron), so the same WebGL spec behavior applies
    // to the same code pattern here — but this was NOT independently
    // reproduced live inside Obsidian for this fix: this session's sandbox
    // runs Obsidian as a pure-Wayland client with no Xwayland window, and no
    // Wayland-native input-injection tool (ydotool/wtype) was available to
    // drive its UI, so a live click-through-and-wait repro was not possible
    // here. Applying the fix anyway because it is unconditionally safe: it
    // only changes buffer-retention behavior between paints and costs nothing
    // in the case where Obsidian's own paint scheduling happens to avoid the
    // symptom already. If a future investigation gets a live repro (or a
    // counter-example) inside Obsidian itself, update this note accordingly
    // — see test/kstep-3d-controller.test.mjs's header comment for why this
    // file (needing a real WebGL context) stays outside plain `node:test`
    // and has no automated regression coverage of its own to update instead.
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Could not create a WebGL renderer: ${msg}` };
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new Color(0xffffff), 1);
  host.appendChild(canvas);

  const scene = new Scene();
  const hemi = new HemisphereLight(0xffffff, 0x444444, 2.0);
  scene.add(hemi);

  // A camera with placeholder framing until the model loads and
  // `frameCamera` below gives it real numbers — never left at a degenerate
  // near/far pair that could produce NaNs if a render were ever requested
  // before `onLoad` fires (it isn't, by design — see `render()` below — but
  // this is cheap insurance against a future change adding one).
  const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(2, 2, 2);
  const keyLight = new DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(1, 1.4, 0.8);
  camera.add(keyLight);
  scene.add(camera);

  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = false;

  let disposed = false;
  let modelLoaded = false;
  let currentRadius = MIN_RADIUS_FALLBACK;
  let center = new Vector3(0, 0, 0);

  const render = (): void => {
    if (disposed || !modelLoaded) return;
    renderer.render(scene, camera);
  };

  const resize = (): void => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    // Obsidian blocks inside a collapsed callout, or a note not yet laid
    // out, can legitimately report zero size — rendering with a zero-sized
    // viewport throws inside three's own render path (or, on some GL
    // implementations, silently produces nothing forever after). Skip until
    // a real size is observed; the ResizeObserver below fires again once the
    // block becomes visible/sized.
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(host);

  controls.addEventListener("change", render);

  const onWheel = (event: WheelEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) return; // Let the note scroll normally otherwise.
    event.preventDefault();
    dolly(event.deltaY < 0 ? 1 / DOLLY_FACTOR : DOLLY_FACTOR);
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function dolly(factor: number): void {
    const offset = camera.position.clone().sub(controls.target);
    offset.multiplyScalar(factor);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  function frameCamera(radius: number, sceneCenter: Vector3): void {
    const safeRadius = radius > 0 ? radius : MIN_RADIUS_FALLBACK;
    currentRadius = safeRadius;
    center = sceneCenter.clone();
    controls.target.copy(center);

    const distance = (safeRadius / HALF_FOV_SIN) * 1.25;
    camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
    camera.near = Math.max(distance / 100, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  const loader = new GLTFLoader();
  loader.parse(
    glb,
    "",
    (gltf) => {
      if (disposed) return; // close() ran before the async parse finished.
      // Added as a whole Group, never a single child extracted out of it —
      // so a future multi-shape GLB (F-1 in the report's deferred-work
      // table) works without any change here.
      scene.add(gltf.scene);

      const box = new Box3().setFromObject(gltf.scene);
      const sceneCenter = new Vector3();
      box.getCenter(sceneCenter);
      const size = new Vector3();
      box.getSize(size);
      // Half the box diagonal — a radius that always fully contains the
      // model regardless of its aspect ratio, which a bounding SPHERE
      // (three.js's own `Box3#getBoundingSphere`) does not guarantee for a
      // very elongated model any better than this does, at the cost of one
      // fewer type imported.
      const radius = Math.max(size.length() / 2, MIN_RADIUS_FALLBACK * 0.001);

      modelLoaded = true;
      frameCamera(radius, sceneCenter);
      resize();
      render();
    },
    (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      onAsyncError?.(msg);
    },
  );

  const handle: Viewer3dHandle = {
    zoomIn(): void {
      dolly(1 / DOLLY_FACTOR);
    },
    zoomOut(): void {
      dolly(DOLLY_FACTOR);
    },
    resetView(): void {
      frameCamera(currentRadius, center);
      render();
    },
    close(): void {
      if (disposed) return;
      disposed = true;

      resizeObserver.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      controls.removeEventListener("change", render);
      controls.dispose();

      scene.traverse((obj) => {
        const withGeometry = obj as { geometry?: { dispose?: () => void } };
        withGeometry.geometry?.dispose?.();
        const withMaterial = obj as { material?: unknown };
        if (withMaterial.material) {
          const materials = Array.isArray(withMaterial.material) ? withMaterial.material : [withMaterial.material];
          for (const m of materials) {
            (m as { dispose?: () => void }).dispose?.();
          }
        }
      });

      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };

  return { ok: true, handle };
}
