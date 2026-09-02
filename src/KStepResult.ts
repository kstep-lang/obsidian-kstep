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

export type RenderContainer = "svg" | "png" | "text";
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
  /** Present only when content === "geometry". */
  triangleCount?: number;
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
