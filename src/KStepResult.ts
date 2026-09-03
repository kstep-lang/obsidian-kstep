/**
 * Types describing the `kstep-cli render ... --output json` contract.
 *
 * Shape verified by real invocations against kstep-cli (see the implementation
 * report for this wave) — not derived from source alone. Two points that are
 * easy to get wrong and are therefore encoded structurally rather than left to
 * runtime checks:
 *
 *  - `occt.reason` (the unavailable-OCCT diagnostic) must never be rendered to
 *    the user: it can contain a local filesystem path / username. The redacted
 *    equivalent already lives in the CLI's text output file. Only `occt.available`
 *    (a boolean) may be read out of the JSON.
 *  - The `validation_failed` error variant carries no top-level `code` field —
 *    unlike every other error variant. Modelled as a discriminated union so
 *    this is a compile error to get wrong, not a runtime surprise.
 */

export type RenderContainer = "svg" | "png" | "text" | "glb";
export type RenderContentKind = "geometry" | "summary" | "notice";

export type OcctInfo =
  | { available: true; version: string }
  // `reason` intentionally present in the type (for completeness / diagnostics
  // tooling) but MUST NOT be rendered into the UI — see file header.
  | { available: false; reason: string };

export interface GeometryInfo {
  detected: boolean;
  shapeCount: number;
  /** Present only when content === "geometry". */
  previewedShapeIndex?: number;
  /**
   * 2D-projected/culled triangle count from the SVG render — present only
   * when content === "geometry". Kept exactly as-is (meaning unchanged).
   */
  triangleCount?: number;
  /**
   * Raw, un-culled world-space triangle count — present only when
   * content === "geometry". Predicts the later `glb.triangleCount` exactly,
   * because GlbWriter only ever drops degenerate triangles (verified against
   * the real CLI: 12 here for hello-box vs. 6 for the 2D-culled
   * `triangleCount` above). Used by `blockOffersViewer` (KStepGlb.ts) to
   * decide 3D-button visibility from the SVG-run JSON, which never carries a
   * `glb` object of its own.
   */
  meshTriangleCount?: number;
}

/**
 * Present only on a success payload from a `-f glb` render — see
 * `renderGlbViaCli` in KStepCliRenderer.ts. Absent entirely from a `-f auto`
 * (SVG/text) run's JSON.
 */
export interface GlbInfo {
  triangleCount: number;
  vertexCount: number;
  droppedTriangleCount: number;
  byteLength: number;
}

export interface KStepSuccessJson {
  status: "success";
  command: "render";
  outPath: string;
  format: RenderContainer;
  content: RenderContentKind;
  fallback: boolean;
  /** Present only when content === "notice". */
  fallbackReason?: string;
  geometry: GeometryInfo;
  occt: OcctInfo;
  rootCount: number;
  /** Present only when format === "glb" (a `renderGlbViaCli` response). */
  glb?: GlbInfo;
}

export interface KStepDiagnostic {
  severity: string;
  message: string;
  line: number | null;
  column: number | null;
}

export interface KStepViolation {
  code: string;
  entityName: string;
  ruleLabel: string;
  expressionText: string;
  message: string;
}

export type KStepErrorJson =
  | {
      status: "error";
      command: "render";
      errorKind: "compilation_error";
      code: string;
      diagnostics: KStepDiagnostic[];
    }
  | {
      status: "error";
      command: "render";
      errorKind: "validation_failed";
      violations: KStepViolation[];
    }
  | {
      status: "error";
      command: "render";
      errorKind: "runtime_error";
      code: string;
      message: string;
      exceptionClass: string;
    }
  | {
      status: "error";
      command: "render";
      errorKind: "no_model_produced";
      code: string;
      message: string;
    }
  | {
      status: "error";
      command: "render";
      errorKind: "geometry_unavailable";
      fallbackReason: string;
      occt: OcctInfo;
    }
  | {
      status: "error";
      command: "render";
      errorKind: "io_error";
      message: string;
    };

export type KStepJson = KStepSuccessJson | KStepErrorJson;

/**
 * What the renderer hands back to the UI layer. Every possible outcome
 * (success in three flavours, a structured CLI error, or an invocation
 * failure such as "binary not found") is a distinct variant here —
 * `renderViaCli` never throws.
 */
export type KStepRenderResult =
  | { kind: "geometry"; svg: string; json: KStepSuccessJson }
  | { kind: "summary"; text: string; json: KStepSuccessJson }
  | { kind: "notice"; text: string; json: KStepSuccessJson }
  | { kind: "cliError"; json: KStepErrorJson }
  | { kind: "invocationError"; title: string; detail: string };

/**
 * What `renderGlbViaCli` hands back — a second, independent CLI invocation
 * only made on explicit user action (clicking the "3D" toggle), never as
 * part of the initial block render. Deliberately NOT folded into
 * `KStepRenderResult` above: doing so would make every existing
 * `switch (result.kind)` over that type non-exhaustive for a case it was
 * never meant to handle, silently (TypeScript only flags a missing case on a
 * `switch` that is itself typed to return a value / assigned to a variable
 * with `never` exhaustiveness checking — main.ts's `paint()` switch is a
 * plain statement switch, so a new unhandled variant would just fall through
 * with no compile error and no visible failure).
 */
export type KStepGlbResult =
  | { kind: "geometry3d"; glb: ArrayBuffer; json: KStepSuccessJson }
  | { kind: "invocationError"; title: string; detail: string };
