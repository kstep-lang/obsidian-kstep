import type { KStepGlbResult, KStepJson, KStepRenderResult } from "./KStepResult";

/**
 * No `obsidian` import in this file, deliberately (unlike obsidian-kuml's
 * KumlCliRenderer.ts, which imports `Platform` and is therefore unusable
 * outside Obsidian). Keeping this module free of the `obsidian` package lets
 * it be bundled and exercised headlessly in scripts/smoke-test.mjs against
 * the real kstep-cli binary. The `Platform.isDesktopApp` guard lives in
 * main.ts instead.
 */

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
}

/**
 * Total-work budget (in characters) for `extractJson`'s search across the
 * whole stdout buffer — see that function's doc comment (DoS guard). Unlike
 * the `MAX_JSON_CANDIDATES_PER_LINE` cap this replaces (which bounded work
 * *per line* and, because candidates were tried left-to-right, could skip
 * straight past a legitimate payload whenever 64+ `{` characters preceded it
 * on the same line — see the doc comment below for the fix), this bounds
 * total characters walked across *all* lines examined, independent of how
 * many brace-like characters any single line contains.
 */
const MAX_TOTAL_SCAN_CHARS = 2 * 1024 * 1024;

/**
 * Fixed per-candidate-line overhead added to `MAX_TOTAL_SCAN_CHARS`'s running
 * total in `extractJson`, on top of the actual characters walked for that
 * line. Without this, the character budget alone bounds total *characters*
 * scanned but not total *lines examined* / `JSON.parse` calls attempted: a
 * pathological buffer made of many very short brace-ending lines (e.g.
 * `{,}\n` repeated) costs almost nothing per line under the character count
 * alone, so ~2 MiB of budget allows roughly 700,000 `JSON.parse` throws
 * before the scan gives up — each one measurably more expensive than a
 * character comparison (exception construction, incl. stack). This constant
 * makes each candidate line cost at least `CANDIDATE_LINE_OVERHEAD`
 * characters of budget regardless of its actual length, capping the number
 * of lines examined (and therefore `JSON.parse` attempts) at roughly
 * `MAX_TOTAL_SCAN_CHARS / CANDIDATE_LINE_OVERHEAD` ≈ 32,000 for the current
 * budget, independent of how short those lines are.
 */
const CANDIDATE_LINE_OVERHEAD = 64;

/**
 * Upper bound on a kstep block's own script size, mirroring the sibling
 * obsidian-ktriz plugin's `MAX_SCRIPT_BYTES` (see its KtrizCliRenderer.ts).
 * kSTEP is pre-M1 and has no equivalent CLI-side script-size guard to mirror
 * yet, but writing an arbitrarily large user-supplied block to a temp file
 * and handing it to the JVM unchecked is its own resource-exhaustion surface
 * regardless of what the CLI does with it.
 */
const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Upper bound on the CLI's output FILE (the rendered SVG or text preview),
 * independent of the 5 MiB `maxBuffer` on stdout below. Unlike stdout, the
 * output file has no size limit of its own: a dense CAD model can produce an
 * SVG with tens of thousands of `<polygon>` elements, tens to hundreds of MB,
 * which would otherwise be read whole into a string, parsed whole into the
 * DOM, and then kept whole in the render cache (`RenderCache` bounds entry
 * *count*, not bytes) — enough to freeze or OOM Obsidian from a single note.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Upper bound on a `-f glb` render's output FILE, deliberately separate from
 * (and larger than) `MAX_OUTPUT_BYTES` above. A GLB buffer is denser per
 * triangle than an SVG: not indexed, POSITION + NORMAL, float32 — at OCCT's
 * own `MAX_TRIANGLES` ceiling of 130,000 that works out to
 * 130,000 × 3 verts × 2 attrs × 3 floats × 4 bytes ≈ 8.93 MiB, already over
 * the SVG limit for a perfectly legitimate maximal model. 16 MiB leaves
 * headroom above that real ceiling instead of rejecting a valid render at an
 * arbitrary boundary.
 */
const MAX_GLB_BYTES = 16 * 1024 * 1024;

/**
 * Extracts the trailing JSON document from kstep-cli's stdout.
 *
 * kstep-cli passes the user script's OWN stdout (arbitrary `println` calls
 * made while the script evaluates) through unmodified, BEFORE it prints its
 * own result object — verified against the real CLI
 * (dev/kstep/cli/RenderCommand.kt: script evaluation via KStepScriptHost.eval
 * always runs first; reportSuccess/printExportError, the only two call sites
 * that print the JSON payload in `--output json` mode, are always the LAST
 * thing either function does before returning/exitProcess). That user output
 * can legitimately contain a lone unpaired `"` (`println("width: 5\"")`) or a
 * lone unpaired `{`/`}` (any debug print with a brace in it) — scanning the
 * whole buffer for quote/brace pairing, as a previous version of this
 * function did, lets a single such character in the user's own output
 * desynchronise string/depth tracking for the rest of the scan and swallow
 * the real payload (`inString`/`depth` never resettle before the actual JSON
 * arrives), producing a false "kstep-cli produced no output" invocation
 * error for an otherwise-successful render.
 *
 * Because the CLI's own JSON is always the last thing IT prints, and
 * `kotlinx.serialization`'s default `JsonObject.toString()` is compact (no
 * embedded raw newlines — newlines inside string values are escaped as
 * `\n`), the payload always ENDS a stdout line — but it does not necessarily
 * START one. A user script that calls Kotlin's `print` (no trailing
 * newline) leaves its own output and the CLI's JSON payload sharing a single
 * physical line, e.g. `progress: ...{"status":"success",...}`. Requiring the
 * line to *start* with `{` (a prior version of this function did) skips that
 * line entirely and reports a false invocation failure.
 *
 * So this scans LINES from the end, and for each line ending in `}`, finds
 * the ONE candidate start position with a single string-aware, brace-depth
 * walk of that line from right to left (`findJsonObjectStart` below), then
 * calls `JSON.parse` exactly once on the resulting slice — instead of the
 * previous approach of trying every `{` on the line as a candidate,
 * left to right. The right-to-left walk starts at the line's own trailing
 * `}` (depth 1) and, tracking JSON string/escape state so a `{`/`}` inside a
 * quoted string value never counts, decrements on `{` / increments on `}`
 * until depth returns to 0 — the position where that happens is the start
 * of the *innermost enclosing* balanced object for that trailing `}`, found
 * in O(that object's own length), regardless of how much unrelated content
 * (balanced or not) precedes it earlier on the same line: an earlier stray
 * unmatched `{` in the user's own prior output is simply never reached,
 * because the walk already stopped once ITS OWN depth resolved to 0. If the
 * nearest brace-ending line isn't the real payload (e.g. the user's script
 * itself printed a `{...}`-shaped last line — pathological but not
 * impossible, or this line's `}` never resolves to a balanced start at
 * all), keep walking backward to earlier lines rather than giving up after
 * the first failed line.
 *
 * This is the fix for a regression a previous version of this cap
 * introduced: bounding the *count* of `{` candidates tried per line (a
 * `MAX_JSON_CANDIDATES_PER_LINE` cap, tried left to right) meant that any
 * line with 64 or more `{` characters BEFORE the real payload — e.g. a
 * user script that `print`s (no newline) a product-structure dump or 64+
 * debug entries each containing a brace — exhausted every allowed candidate
 * before the scan ever reached the payload's own `{`, producing a false
 * "kstep-cli produced no output" invocation error for an otherwise
 * successful render. Matching from the line's own known-good end instead of
 * guessing candidates from the front sidesteps the problem entirely: the
 * number of characters walked is bounded by the size of the JSON object
 * itself (or, in the failure case, the line), never by how many stray `{`
 * characters happen to precede it.
 *
 * `stdout.split("\n")` avoids walking every byte of large, brace-dense user
 * output even when the payload is immediately found on the last line. The
 * per-line walk itself is linear in that line's length (each character is
 * visited once, with `JSON.parse` called at most once per candidate line),
 * so unlike the old "try every `{`, left to right" approach — where a
 * single candidate that turned out to be unbalanced could make `JSON.parse`
 * scan close to the *entire* remainder of the line before throwing, once
 * per candidate, i.e. O(k × remaining-line-length) for a line with k
 * brace-nested candidates — this scan is never quadratic in line length.
 * `MAX_TOTAL_SCAN_CHARS` additionally bounds the total characters walked
 * across *all* candidate lines examined (not just one), as a defence-in-
 * depth ceiling on total work independent of that per-line linearity: once
 * the running total exceeds it, the scan stops and reports no payload found
 * rather than continuing indefinitely against a pathologically large
 * buffer with no valid payload anywhere in it. The budget is charged AFTER
 * each candidate line is examined, not before — charging it up front (a
 * prior version of this function did) means the very first candidate line
 * tried is skipped unexamined whenever ITS OWN length alone exceeds the
 * budget, which is exactly the line most likely to carry the real payload
 * (the CLI's JSON always ends the LAST such line, so the first one tried in
 * this right-to-left scan). What is charged is the actual work done — the
 * length of the parsed slice on success (`line.length - start`), or the
 * line's own full length when no balanced object was found — plus
 * `CANDIDATE_LINE_OVERHEAD` per line to also bound the number of lines
 * examined (see that constant's doc comment), not just their combined
 * length.
 *
 * A candidate that parses as JSON and carries a recognised `status` is
 * *still* not trusted on that basis alone — `isValidKStepJson` additionally
 * checks the fields each downstream branch dereferences unconditionally
 * (`outPath`, `geometry.shapeCount`, `diagnostics`, …). kSTEP is pre-M1 and
 * its `--output json` schema is therefore not yet stable; a candidate that
 * parses but fails that structural check is treated exactly like one that
 * failed to parse — the scan moves on to the next `{` on the line, or the
 * next line — rather than being returned and later crashing a caller that
 * assumed the shape (see `isValidKStepJson`'s own doc comment below for the
 * concrete crash this prevents).
 */
/**
 * Finds the start position of the balanced JSON object whose closing `}` is
 * the last character of `line`, by walking `line` right to left with a
 * string/escape-aware brace-depth counter — see `extractJson`'s doc comment
 * above for why right-to-left (not left-to-right, and not a whole-line
 * forward balance check) is the approach that is robust both to a stray
 * unmatched `{` earlier in the user's own prior output on the same line,
 * and to a `{`/`}` appearing literally inside one of the payload's own
 * quoted string values (e.g. a compiler diagnostic message that quotes a
 * `'}'` character).
 *
 * Returns -1 if `line` does not end in a balanced object (walking all the
 * way to index 0 without depth returning to 0) — this is a normal, expected
 * outcome for lines that are pure user output, not a malformed-input error.
 *
 * `line` is assumed already trimmed and non-empty with `line.endsWith("}")`
 * verified by the caller.
 */
function findJsonObjectStart(line: string): number {
  let depth = 0;
  let inString = false;

  for (let i = line.length - 1; i >= 0; i--) {
    const ch = line[i];

    if (ch === '"') {
      // A quote is a real string delimiter unless it is itself escaped —
      // which, per JSON's escaping rule, is determined by the parity of the
      // run of `\` characters immediately to its left (`\"` escaped, `\\"`
      // not — the backslash is itself escaped by its own left neighbour —
      // `\\\"` escaped, and so on). This local look-back is direction-
      // agnostic: it gives the same answer walking right to left as it
      // would walking left to right, so it does not depend on having seen
      // the rest of the line first.
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === "\\") {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
      continue;
    }

    if (inString) continue; // Braces inside a string value never count.

    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1; // Defensive: should be unreachable — see above, we return as soon as depth hits 0.
    }
  }

  return -1;
}

export function extractJson(stdout: string): KStepJson | null {
  const lines = stdout.split("\n");
  let scannedChars = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (!line.endsWith("}")) continue;

    const start = findJsonObjectStart(line);
    // Charge the budget for the work actually done on this line — the
    // parsed slice's own length on success, or the whole line when no
    // balanced object was found — AFTER attempting it, so the budget can
    // never cause a candidate line to be skipped unexamined. See
    // `CANDIDATE_LINE_OVERHEAD`'s doc comment for the fixed per-line term.
    scannedChars += CANDIDATE_LINE_OVERHEAD + (start === -1 ? line.length : line.length - start);

    if (start !== -1) {
      try {
        const parsed: unknown = JSON.parse(line.slice(start));
        if (parsed !== null && typeof parsed === "object" && isValidKStepJson(parsed)) {
          return parsed;
        }
      } catch {
        // Structurally balanced but not valid/relevant JSON — fall through
        // to earlier lines rather than giving up on the whole scan.
      }
    }

    if (scannedChars > MAX_TOTAL_SCAN_CHARS) return null;
  }

  return null;
}

/**
 * Structural guard for a parsed JSON candidate before `extractJson` trusts
 * it as a `KStepJson` (fixes a MAJOR bug: a `status` of "success"/"error"
 * alone used to be enough to return a value). Every field checked here is
 * one that a downstream caller dereferences unconditionally without its own
 * null/type check:
 *
 *  - `renderViaCli` does `path.resolve(json.outPath)` on a success payload —
 *    a missing/non-string `outPath` threw a `TypeError` *inside* the
 *    `execFile` callback. Because that callback runs in a `new Promise`
 *    executor and nothing there catches it, `resolve()` was never reached:
 *    the returned promise hung forever, which in turn hung
 *    `ConcurrencyGate.run`'s `finally { this.release() }` (a stuck slot in
 *    main.ts's gate) and left the block's "Running kSTEP script…" spinner in
 *    main.ts showing forever, with no error card ever painted.
 *  - `KStepCard.renderGeometry` reads `json.geometry.shapeCount` and
 *    `KStepCard.renderCliError` iterates `json.diagnostics` /
 *    `json.violations` unconditionally for their respective `errorKind`s —
 *    both throw the same way on a payload missing those fields.
 *  - Within that iteration, `renderCliError` also dereferences fields of
 *    each individual ARRAY ELEMENT unconditionally (`d.line`, `d.message`
 *    for a diagnostic; `v.code`, `v.entityName`, `v.message` for a
 *    violation) — checking only that `diagnostics`/`violations` themselves
 *    are arrays is not enough: a `null` (or otherwise non-object) element
 *    throws the same `TypeError` one level down. So this checks each
 *    element is a non-null object too, not just the array that contains it.
 *
 * kSTEP has no release yet (pre-M1), so its JSON shape can still drift
 * between builds; a payload that fails this check is treated as if it had
 * failed to parse at all (see `extractJson`), not returned to the caller.
 *
 * Deliberately narrow: this checks only the fields actually dereferenced
 * unconditionally elsewhere, not the full `KStepJson` shape (e.g. optional
 * fields, and `occt`'s `available`/`reason`/`version` split, are already
 * read defensively downstream).
 */
/** `true` for anything `renderCliError` can safely dereference fields of — excludes `null` (typeof "object") and arrays/functions are fine to allow through since a missing field just reads as `undefined`, not a throw. */
function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isValidKStepJson(parsed: object): parsed is KStepJson {
  const obj = parsed as Record<string, unknown>;

  if (obj.status === "success") {
    const geometry = obj.geometry;
    return (
      typeof obj.outPath === "string" &&
      typeof obj.format === "string" &&
      typeof obj.content === "string" &&
      typeof obj.fallback === "boolean" &&
      typeof obj.rootCount === "number" &&
      geometry !== null &&
      typeof geometry === "object" &&
      typeof (geometry as Record<string, unknown>).shapeCount === "number" &&
      obj.occt !== null &&
      typeof obj.occt === "object"
    );
  }

  if (obj.status === "error") {
    switch (obj.errorKind) {
      case "compilation_error":
        return Array.isArray(obj.diagnostics) && obj.diagnostics.every(isNonNullObject);
      case "validation_failed":
        return Array.isArray(obj.violations) && obj.violations.every(isNonNullObject);
      case "runtime_error":
        return typeof obj.message === "string" && typeof obj.exceptionClass === "string";
      case "no_model_produced":
      case "io_error":
        return typeof obj.message === "string";
      case "geometry_unavailable":
        return typeof obj.fallbackReason === "string" && obj.occt !== null && typeof obj.occt === "object";
      default:
        // Unknown/missing errorKind — not one of the discriminated-union
        // variants in KStepResult.ts, so downstream `switch` statements
        // could not have handled it correctly either.
        return false;
    }
  }

  return false;
}

/**
 * Strips JVM/SLF4J housekeeping noise from stderr before it is shown to the
 * user. Pattern verified against real kstep-cli stderr output.
 */
export function filterStderr(stderr: string): string {
  return (stderr ?? "")
    .split("\n")
    .filter((line) => {
      if (line.trim().length === 0) return false;
      if (line.startsWith("WARNING:")) return false;
      if (line.includes("SLF4J")) return false;
      if (/^\[main] (INFO|DEBUG|TRACE) /.test(line)) return false;
      if (line.startsWith("Wrote ")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Renders a kSTEP script by invoking the kstep-cli binary once.
 *
 * Never throws for any outcome of a well-formed invocation — geometry
 * preview, product-structure summary, fallback notice, structured CLI
 * error, and invocation failures such as "binary not found" or a timeout
 * all come back as a `KStepRenderResult` variant. This does NOT cover a
 * `cliPath` that isn't a plausible path string at all (e.g. not a string,
 * or containing a NUL byte): `child_process.execFile` validates its
 * arguments synchronously and throws (`ERR_INVALID_ARG_TYPE` /
 * `ERR_INVALID_ARG_VALUE`) before the callback above ever runs, which this
 * function does not catch. main.ts guards against that by validating
 * `cliPath`'s type in `loadSettings` and wrapping this call in try/catch —
 * any other caller (e.g. scripts/smoke-test.mjs) must do the same rather
 * than relying on this comment's older, broader "never throws" claim.
 *
 * Invocation contract (verified against the real CLI, do not change casually):
 *   <cliPath> render <tmpdir>/block.kstep.kts -f auto -o <tmpdir>/out --output json
 *
 *  - `-o` is deliberately given WITHOUT a file extension. With an extension,
 *    `RenderFormat.fromExtension` forces the container format regardless of
 *    content, and a text/summary response would be wrapped as an SVG
 *    <text> element (unselectable, unsearchable). Extension-less lets the
 *    CLI's content-based format resolution choose svg vs. text.
 *  - `--require-geometry` is deliberately NOT set — it would turn the
 *    friendly "notice" fallback (exit 0) into a hard error (exit 1).
 *
 * On a script/compilation/validation error, kstep-cli exits with code 1 but
 * still prints the full structured JSON diagnostics to stdout, with stderr
 * reduced to (filtered-out) JVM noise. So stdout is ALWAYS parsed first,
 * regardless of whether `error` is set — only when no JSON can be found on
 * stdout do we fall back to interpreting `error`/stderr (an ENOENT — no
 * stdout at all in that case — is checked first, before any parsing).
 */
export async function renderViaCli(source: string, cliPath: string): Promise<KStepRenderResult> {
  // eval("require") is the canonical Obsidian-plugin pattern for accessing
  // Node built-ins from a CJS bundle without triggering Electron's browser-side
  // ESM resolver, while remaining loadable (this module is never evaluated) on
  // mobile, where these built-ins do not exist.
  // eslint-disable-next-line no-eval
  const req = eval("require") as NodeRequire;
  const childProcess = req("child_process") as typeof import("child_process");
  const fs = req("fs") as typeof import("fs");
  const os = req("os") as typeof import("os");
  const path = req("path") as typeof import("path");

  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > MAX_SCRIPT_BYTES) {
    return {
      kind: "invocationError",
      title: "kSTEP block too large",
      detail: `kSTEP blocks are limited to ${MAX_SCRIPT_BYTES} bytes (1 MiB); this block is ${sourceBytes} bytes.`,
    };
  }

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-kstep-"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "invocationError", title: "Could not create a temp directory", detail: msg };
  }

  const inFile = path.join(dir, "block.kstep.kts");
  const outFile = path.join(dir, "out");

  try {
    try {
      // `mode: 0o600` (owner read/write only) and `flag: "wx"`
      // (`O_CREAT|O_EXCL`, refuses to follow a pre-existing file or symlink)
      // as a second layer of hardening independent of the temp directory's
      // own 0700 permissions (mkdtempSync above) — mirrors obsidian-ktriz's
      // KtrizCliRenderer.ts, which documents the same reasoning: without
      // this, the default 0666-minus-umask mode (typically 0644) leaves the
      // note's own source text world-readable on a filesystem without a
      // restrictive umask, for the render's whole duration.
      fs.writeFileSync(inFile, source, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "invocationError", title: "Could not write a temp file", detail: msg };
    }

    const args = ["render", inFile, "-f", "auto", "-o", outFile, "--output", "json"];

    // eslint-disable-next-line no-async-promise-executor
    return await new Promise<KStepRenderResult>((resolve) => {
      childProcess.execFile(
        cliPath,
        args,
        {
          timeout: 60_000,
          maxBuffer: 5 * 1024 * 1024,
          // Default `killSignal` is SIGTERM, which a JVM stuck inside a
          // native OCCT call can simply never get around to handling —
          // Node still frees the `ConcurrencyGate` slot awaiting this
          // promise immediately after sending it (KStepScheduler.ts), so an
          // ignored SIGTERM leaves the JVM running as an orphan indefinitely
          // while new renders queue up behind an unbounded number of them,
          // AND the `finally` block below deletes its temp directory out
          // from under it. SIGKILL cannot be caught, blocked, or ignored, so
          // the timeout is a real deadline: the process is gone (and this
          // callback fires) before `finally` runs `rmSync`.
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          // Defence in depth for this function's documented "never throws"
          // contract (see the header comment above, and KStepResult.ts). The
          // structural validation in `isValidKStepJson` should make an
          // exception here unreachable, but this callback runs inside a
          // `new Promise` executor with no other catch around it — if an
          // exception ever DID escape (e.g. a future edit re-introduces an
          // unguarded field access), `resolve()` would never be called and
          // the returned promise would hang forever, wedging the
          // `ConcurrencyGate` slot that's awaiting it (main.ts /
          // KStepScheduler.ts) and leaving the block's "Running kSTEP
          // script…" spinner (main.ts) on screen permanently with no error
          // card ever painted. Catching here turns that failure mode back
          // into an ordinary `invocationError` result.
          try {
            const error = err as ExecFileError | null;

            // 1. ENOENT first: there is no stdout to parse in that case.
            if (error && error.code === "ENOENT") {
              resolve({
                kind: "invocationError",
                title: `kSTEP CLI not found: ${cliPath}`,
                detail:
                  "Set the path in Settings → kSTEP Models. The binary is called kstep-cli in a " +
                  "Gradle installDist build (kstep-cli/build/install/kstep-cli/bin/kstep-cli), " +
                  "or kstep if installed via a package manager.",
              });
              return;
            }

            // 2. Always parse stdout first — even when `error` is set. Exit
            // code 1 with structured JSON on stdout is the CLI's normal shape
            // for a script error, not an invocation failure.
            const json = extractJson(stdout ?? "");
            if (json) {
              if (json.status === "error") {
                resolve({ kind: "cliError", json });
                return;
              }

              // status === "success" — the output file exists, read it. Verify
              // the path the CLI reports matches what we asked for before
              // trusting it (the CLI is observed to echo -o back exactly).
              const expected = path.resolve(outFile);
              const actual = path.resolve(json.outPath);
              if (actual !== expected) {
                resolve({
                  kind: "invocationError",
                  title: "Unexpected output path from kSTEP CLI",
                  detail: `Expected ${expected}, got ${json.outPath}.`,
                });
                return;
              }

              let text: string;
              try {
                const stat = fs.statSync(outFile);
                if (stat.size > MAX_OUTPUT_BYTES) {
                  resolve({
                    kind: "invocationError",
                    title: "kSTEP CLI output too large",
                    detail: `The rendered output is ${stat.size} bytes, over the ${MAX_OUTPUT_BYTES}-byte limit.`,
                  });
                  return;
                }
                text = fs.readFileSync(outFile, "utf-8");
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                resolve({ kind: "invocationError", title: "Could not read kSTEP CLI output", detail: msg });
                return;
              }

              if (json.content === "geometry" && json.format === "svg" && text.includes("<svg")) {
                resolve({ kind: "geometry", svg: text, json });
                return;
              }
              if (json.content === "notice") {
                resolve({ kind: "notice", text, json });
                return;
              }
              // "summary", or a "geometry" response that unexpectedly isn't a
              // valid SVG (defensive — not reachable with the flags above).
              resolve({ kind: "summary", text, json });
              return;
            }

            // 3. No JSON found on stdout → timeout, usage text, or a crash
            // outside the CLI's own structured error handling.
            if (error?.killed) {
              resolve({
                kind: "invocationError",
                title: "kSTEP CLI timed out",
                detail: "The render call did not finish within 60 seconds.",
              });
              return;
            }
            const detail =
              filterStderr(stderr ?? "") || (error ? error.message : "kstep-cli produced no output.");
            resolve({ kind: "invocationError", title: "kSTEP CLI invocation failed", detail });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            resolve({
              kind: "invocationError",
              title: "kSTEP CLI produced an unexpected result",
              detail: msg,
            });
          }
        },
      );
    });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Renders a kSTEP script's geometry as a binary glTF (GLB) buffer, by
 * invoking the kstep-cli binary a SECOND time with `-f glb` forced. This is
 * NEVER called as part of the initial block render (that stays exactly the
 * `-f auto` SVG/text call in `renderViaCli` above, unchanged) — only on
 * explicit user action, when the "3D" toggle is clicked (see main.ts).
 *
 * Structurally a close mirror of `renderViaCli` (same mkdtemp/writeFileSync/
 * execFile/finally-rmSync shape, same `extractJson`/`filterStderr` reuse),
 * with these deliberate differences:
 *
 *  - `-f glb` is passed explicitly, so `RenderFormat.fromExtension`'s
 *    extension-based resolution never runs — `-o` still has no extension of
 *    its own (kept for consistency with `renderViaCli`; irrelevant here
 *    since the format is forced).
 *  - `--require-geometry` is still deliberately NOT set: a model with zero
 *    triangles (e.g. product-structure-only, or a fallback-to-notice case)
 *    comes back as a valid, tiny, zero-triangle GLB rather than a hard CLI
 *    error — rejected here by `shouldOfferViewer`/`blockOffersViewer`
 *    (KStepGlb.ts), not by exit code.
 *  - The output file is read as a `Buffer` (no `"utf-8"` encoding — a GLB is
 *    binary), then copied into a freshly allocated `ArrayBuffer` via
 *    `slice(byteOffset, byteOffset + byteLength)`. This copy is required, not
 *    optional: Node's `Buffer.buffer` frequently points into a larger, SHARED
 *    pool `ArrayBuffer` (`Buffer.poolSize`-backed allocations), so handing
 *    `buf.buffer` straight to `GLTFLoader.parse` would leak unrelated pool
 *    bytes into the parser and, over the buffer's read range, potentially
 *    read memory reused by an unrelated, later `Buffer` allocation.
 *  - Size ceiling is `MAX_GLB_BYTES` (16 MiB), not `MAX_OUTPUT_BYTES`.
 *  - `json.format !== "glb"` is rejected as an `invocationError` — the CLI
 *    wrote something other than what was asked for.
 */
export async function renderGlbViaCli(source: string, cliPath: string): Promise<KStepGlbResult> {
  // See renderViaCli's identical comment above for why `eval("require")`.
  // eslint-disable-next-line no-eval
  const req = eval("require") as NodeRequire;
  const childProcess = req("child_process") as typeof import("child_process");
  const fs = req("fs") as typeof import("fs");
  const os = req("os") as typeof import("os");
  const path = req("path") as typeof import("path");

  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > MAX_SCRIPT_BYTES) {
    return {
      kind: "invocationError",
      title: "kSTEP block too large",
      detail: `kSTEP blocks are limited to ${MAX_SCRIPT_BYTES} bytes (1 MiB); this block is ${sourceBytes} bytes.`,
    };
  }

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-kstep-"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "invocationError", title: "Could not create a temp directory", detail: msg };
  }

  const inFile = path.join(dir, "block.kstep.kts");
  const outFile = path.join(dir, "out");

  try {
    try {
      // Same 0700-dir + 0600-file + wx double-hardening as renderViaCli.
      fs.writeFileSync(inFile, source, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "invocationError", title: "Could not write a temp file", detail: msg };
    }

    const args = ["render", inFile, "-f", "glb", "-o", outFile, "--output", "json"];

    // eslint-disable-next-line no-async-promise-executor
    return await new Promise<KStepGlbResult>((resolve) => {
      childProcess.execFile(
        cliPath,
        args,
        {
          timeout: 60_000,
          maxBuffer: 5 * 1024 * 1024,
          // Same reasoning as renderViaCli: SIGKILL, not the SIGTERM default,
          // because a JVM stuck inside a native OCCT call can never get
          // around to handling SIGTERM, and the `finally` block below deletes
          // its temp directory out from under it regardless.
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          // Same defence-in-depth reasoning as renderViaCli's callback: this
          // runs inside a `new Promise` executor with no other catch around
          // it, so an escaping exception here would hang the returned
          // promise forever rather than surface as an ordinary result.
          try {
            const error = err as ExecFileError | null;

            if (error && error.code === "ENOENT") {
              resolve({
                kind: "invocationError",
                title: `kSTEP CLI not found: ${cliPath}`,
                detail:
                  "Set the path in Settings → kSTEP Models. The binary is called kstep-cli in a " +
                  "Gradle installDist build (kstep-cli/build/install/kstep-cli/bin/kstep-cli), " +
                  "or kstep if installed via a package manager.",
              });
              return;
            }

            const json = extractJson(stdout ?? "");
            if (json) {
              if (json.status === "error") {
                resolve({
                  kind: "invocationError",
                  title: "kSTEP CLI could not produce a 3D model",
                  detail:
                    json.errorKind === "geometry_unavailable"
                      ? json.fallbackReason
                      : "The 3D render failed. See the 2D preview's own error state for details.",
                });
                return;
              }

              if (json.format !== "glb") {
                resolve({
                  kind: "invocationError",
                  title: "Unexpected format from kSTEP CLI",
                  detail: `Expected format "glb", got "${json.format}".`,
                });
                return;
              }

              const expected = path.resolve(outFile);
              const actual = path.resolve(json.outPath);
              if (actual !== expected) {
                resolve({
                  kind: "invocationError",
                  title: "Unexpected output path from kSTEP CLI",
                  detail: `Expected ${expected}, got ${json.outPath}.`,
                });
                return;
              }

              let glb: ArrayBuffer;
              try {
                const stat = fs.statSync(outFile);
                if (stat.size > MAX_GLB_BYTES) {
                  resolve({
                    kind: "invocationError",
                    title: "kSTEP 3D output too large",
                    detail: `The rendered GLB is ${stat.size} bytes, over the ${MAX_GLB_BYTES}-byte limit.`,
                  });
                  return;
                }
                const buf = fs.readFileSync(outFile);
                // Copy out of Node's (possibly shared-pool) Buffer — see this
                // function's doc comment above for why this slice is required,
                // not optional.
                glb = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                resolve({ kind: "invocationError", title: "Could not read kSTEP 3D output", detail: msg });
                return;
              }

              resolve({ kind: "geometry3d", glb, json });
              return;
            }

            if (error?.killed) {
              resolve({
                kind: "invocationError",
                title: "kSTEP CLI timed out",
                detail: "The 3D render did not finish within 60 seconds.",
              });
              return;
            }
            const detail =
              filterStderr(stderr ?? "") || (error ? error.message : "kstep-cli produced no output.");
            resolve({ kind: "invocationError", title: "kSTEP CLI invocation failed", detail });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            resolve({
              kind: "invocationError",
              title: "kSTEP CLI produced an unexpected result",
              detail: msg,
            });
          }
        },
      );
    });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
