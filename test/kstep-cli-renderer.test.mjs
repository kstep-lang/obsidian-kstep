import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./helpers/loadModule.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(__dirname, "helpers", "fakeKstepCli.mjs");

const { extractJson, filterStderr, renderViaCli, renderGlbViaCli } = await loadModule("src/KStepCliRenderer.ts");

test("extractJson: parses a clean success object", () => {
  const stdout =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true,"shapeCount":1},"occt":{"available":true,"version":"7.7"},"rootCount":1}';
  const json = extractJson(stdout);
  assert.equal(json?.status, "success");
  assert.equal(json?.rootCount, 1);
});

test("extractJson: finds the object even with an unbalanced brace inside a JSON string value (CRITICAL regression)", () => {
  // Real kstep-cli output for a Kotlin source with a missing closing brace —
  // the diagnostic message itself quotes an unmatched "}", which used to
  // desynchronise the old backward brace-counter and make extractJson
  // return null for the single most common user mistake.
  const stdout =
    '{"status":"error","errorKind":"compilation_error","code":"KSTEP-S-001",' +
    "\"diagnostics\":[{\"severity\":\"ERROR\",\"message\":\"Syntax error: Expecting '}'.\",\"line\":3,\"column\":1}]," +
    '"command":"render"}';
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to find the object despite the quoted \"}\"");
  assert.equal(json.status, "error");
  assert.equal(json.errorKind, "compilation_error");
  assert.equal(json.diagnostics[0].message, "Syntax error: Expecting '}'.");
  assert.equal(json.diagnostics[0].line, 3);
});

test("extractJson: skips leading JVM/SLF4J noise before the JSON payload", () => {
  const stdout =
    "WARNING: sun.misc.Unsafe::objectFieldOffset\nSLF4J(W): No providers found\n" +
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"7.7"},"rootCount":2}';
  const json = extractJson(stdout);
  assert.equal(json?.status, "success");
  assert.equal(json?.rootCount, 2);
});

test("extractJson: escaped quotes inside a string do not end the string early", () => {
  const stdout =
    '{"status":"error","errorKind":"runtime_error","code":"X","message":"a \\"quoted } value\\" here",' +
    '"exceptionClass":"Boom","command":"render"}';
  const json = extractJson(stdout);
  assert.ok(json);
  assert.equal(json.message, 'a "quoted } value" here');
});

test("extractJson: picks the LAST top-level object when several appear (trailing result wins)", () => {
  const first =
    '{"status":"success","command":"render","outPath":"/tmp/a","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":1}';
  const second =
    '{"status":"success","command":"render","outPath":"/tmp/b","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":9}';
  const stdout = `${first}\nnoise {} more noise\n${second}`;
  const json = extractJson(stdout);
  assert.equal(json?.rootCount, 9);
});

test("extractJson: returns null when stdout has no JSON object at all", () => {
  assert.equal(extractJson("usage: kstep-cli [command]"), null);
});

test("extractJson: returns null for an empty string", () => {
  assert.equal(extractJson(""), null);
});

test("extractJson: finds the payload after a lone unpaired quote in the user script's own stdout (CRITICAL regression)", () => {
  // Real kstep-cli passes the user script's own println output through
  // unmodified before printing its result object. A script that prints e.g.
  // an inch measurement (`println("width: 5\"")`) puts a single, unpaired
  // `"` on stdout ahead of the JSON payload. The old character-scanning
  // extractJson treated every `"` on stdout as entering/leaving a JSON
  // string, so this lone quote flipped it into "inside a string" for the
  // rest of the scan and swallowed the real payload's opening `{`.
  const payload =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true,"shapeCount":1},"occt":{"available":true,"version":"7.7"},"rootCount":1}';
  const stdout = 'script says: a lone quote -> " <- here\n' + payload;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to find the payload despite the lone unpaired quote ahead of it");
  assert.equal(json.status, "success");
  assert.equal(json.rootCount, 1);
});

test("extractJson: finds the payload after a lone unpaired brace in the user script's own stdout (CRITICAL regression)", () => {
  // Same real-CLI scenario as above, but with a lone `{` (e.g. any debug
  // print with an opening brace and no matching close) instead of a lone
  // quote. The old depth-counter treated it as opening a top-level JSON
  // span, so the payload's own `{`/`}` never brought depth back to 0 and no
  // candidate was ever recorded.
  const payload =
    '{"status":"error","errorKind":"runtime_error","code":"X","message":"boom",' +
    '"exceptionClass":"Boom","command":"render"}';
  const stdout = "opening brace only: {\n" + payload;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to find the payload despite the lone unpaired brace ahead of it");
  assert.equal(json.status, "error");
  assert.equal(json.errorKind, "runtime_error");
});

test("extractJson: finds the payload when the user script's prior output has no trailing newline (CRITICAL regression, Round 3)", () => {
  // Real kstep-cli passes the user script's own stdout through unmodified
  // before printing its JSON payload. Kotlin's `print(...)` (no trailing
  // `ln`) leaves no newline before the payload, so the payload shares its
  // stdout LINE with the script's own output instead of starting a fresh
  // one. A version of extractJson that required the candidate line to
  // *start* with `{` skipped this line entirely and returned null.
  const payload =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true,"shapeCount":1},"occt":{"available":true,"version":"7.7"},"rootCount":1}';
  const stdout = "progress: ..." + payload;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to find the payload sharing a line with prior print() output");
  assert.equal(json.status, "success");
  assert.equal(json.rootCount, 1);
});

test("extractJson: skips a false '{' candidate before the real payload on the same line (CRITICAL regression, Round 3)", () => {
  // Same no-trailing-newline scenario, but the user's own `print` output
  // itself contains an opening brace ahead of the real payload on the same
  // line. The first `{` found on the line is a false start (fails to parse
  // as the full remainder of the line); extractJson must keep trying later
  // `{` candidates on that same line rather than giving up.
  const payload =
    '{"status":"error","errorKind":"runtime_error","code":"X","message":"boom",' +
    '"exceptionClass":"Boom","command":"render"}';
  const stdout = "a { b" + payload;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to skip the false '{' and find the real payload on the same line");
  assert.equal(json.status, "error");
  assert.equal(json.errorKind, "runtime_error");
});

test("extractJson: stays roughly linear-time on large stdout dense with brace-like characters (MAJOR regression)", () => {
  const filler = '"noise with braces { { { } } }",'.repeat(20_000);
  const stdout =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    `"fallback":false,"filler":[${filler.slice(0, -1)}],` +
    '"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":1}';

  const start = Date.now();
  const json = extractJson(stdout);
  const elapsed = Date.now() - start;

  assert.ok(json, "expected a parsed result even with many brace-like characters in noise");
  assert.equal(json.status, "success");
  assert.ok(
    elapsed < 1000,
    `extractJson took ${elapsed}ms on a ~${Math.round(stdout.length / 1024)}KB input — expected roughly linear time, not the old O(n^2) blowup`,
  );
});

// ── extractJson: structural validation (MAJOR regression) ──────────────────
//
// Before this fix, `extractJson` trusted ANY object carrying a recognised
// `status` field, with no check that the fields downstream code
// dereferences unconditionally were actually present. A success payload
// missing `outPath` reached `path.resolve(json.outPath)` in `renderViaCli`
// and threw a TypeError *inside* the execFile callback — which, because
// nothing there caught it, meant `resolve()` was never called and the
// returned promise hung forever (see that function's own comments for the
// full chain: a stuck ConcurrencyGate slot, and main.ts's loading spinner
// never removed).

test("extractJson: rejects a success payload missing outPath, geometry and other required fields", () => {
  assert.equal(extractJson('{"status":"success"}'), null);
});

test("extractJson: rejects a success payload whose outPath is not a string", () => {
  const stdout =
    '{"status":"success","command":"render","outPath":123,"format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true,"shapeCount":1},"occt":{"available":true,"version":"1"},"rootCount":1}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: rejects a success payload whose geometry.shapeCount is missing", () => {
  const stdout =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true},"occt":{"available":true,"version":"1"},"rootCount":1}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: rejects a compilation_error payload missing 'diagnostics'", () => {
  assert.equal(extractJson('{"status":"error","errorKind":"compilation_error","code":"X","command":"render"}'), null);
});

test("extractJson: rejects a validation_failed payload missing 'violations'", () => {
  assert.equal(extractJson('{"status":"error","errorKind":"validation_failed","command":"render"}'), null);
});

test("extractJson: rejects a runtime_error payload missing 'exceptionClass'", () => {
  const stdout = '{"status":"error","errorKind":"runtime_error","code":"X","message":"boom","command":"render"}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: rejects a geometry_unavailable payload missing 'fallbackReason'", () => {
  const stdout = '{"status":"error","errorKind":"geometry_unavailable","occt":{"available":false,"reason":"x"},"command":"render"}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: rejects an error payload with an unrecognised errorKind", () => {
  const stdout = '{"status":"error","errorKind":"some_future_kind","command":"render"}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: a structurally invalid trailing object does not shadow a valid payload on an earlier line", () => {
  const validPayload =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"svg","content":"geometry",' +
    '"fallback":false,"geometry":{"detected":true,"shapeCount":1},"occt":{"available":true,"version":"1"},"rootCount":42}';
  // A trailing line that parses as JSON and carries status:"success", but is
  // missing every other required field — must be skipped, not returned, and
  // the scan must keep walking backward to the real payload.
  const stdout = `${validPayload}\n{"status":"success"}`;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to fall back to the valid payload on the earlier line");
  assert.equal(json.rootCount, 42);
});

test("extractJson: still accepts a well-formed success payload (no false positives from the new validation)", () => {
  const stdout =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"7.7"},"rootCount":3}';
  const json = extractJson(stdout);
  assert.ok(json);
  assert.equal(json.status, "success");
  assert.equal(json.rootCount, 3);
});

// ── extractJson DoS guard (MAJOR finding — quadratic runtime on a single,
// brace-dense line) ─────────────────────────────────────────────────────

test("extractJson: a single line with many nested-brace '{' candidates completes quickly (DoS regression)", () => {
  // Reproduces the exact pathological shape from the finding's empirical
  // verification: `'{"a":'.repeat(n) + '1' + '}'.repeat(n)` on one physical
  // line (a user script `print`ing, no newline, a deeply brace-nested debug
  // structure). A left-to-right "try every `{` as a JSON.parse candidate"
  // approach was quadratic here (~0.2s at n=2000 growing to ~8.8s at
  // n=16000, i.e. O(n^2)), and a later fix that capped the number of
  // candidates tried per line (`MAX_JSON_CANDIDATES_PER_LINE`) was itself a
  // regression: it made this fast again but at the cost of skipping *real*
  // payloads whenever 64+ `{` characters legitimately preceded them on one
  // line — not a "vanishingly unlikely attack shape" at all, just any
  // `print`-based debug dump with a few dozen braces in it. `extractJson`'s
  // current implementation instead walks each candidate line right to left
  // exactly once (`findJsonObjectStart`), which is linear in that line's
  // length regardless of how many `{`/`}` characters it contains — this
  // input is fully balanced, so the whole ~120 KiB line is walked once and
  // `JSON.parse`d once, no candidate cap or false-negative trade-off
  // involved. It still must complete in well under a second, and — being a
  // deliberately pathological line with no "status" field — no valid
  // payload is expected to be found on it; see the sibling test below for
  // the realistic case, a handful of stray braces, where the payload is
  // still found.
  const n = 20000;
  const poison = '{"a":'.repeat(n) + "1" + "}".repeat(n);

  const start = Date.now();
  const json = extractJson(poison);
  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < 1000,
    `expected extractJson to finish in well under 1s (linear right-to-left scan), took ${elapsedMs}ms`,
  );
  // Not itself a valid KStepJson payload (no "status" field at all) —
  // capped or not, this line was never going to return non-null. The
  // timing assertion above is the actual regression guard.
  assert.equal(json, null);
});

test("extractJson: still finds the payload when a handful of stray '{' precede it on the same line (no false negative from the cap)", () => {
  const stdout =
    'progress: {a {b {c ' +
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":7}';
  const json = extractJson(stdout);
  assert.ok(json);
  assert.equal(json.rootCount, 7);
});

test("extractJson: still finds the payload when 70+ balanced '{...}' groups precede it on the same line (MAJOR regression fix)", () => {
  // The exact end-to-end repro from the finding: a script that calls
  // Kotlin's `print` (no newline) 70 times in a loop, e.g.
  // `repeat(70) { print("{node ${it}}") }`, each call itself a small
  // balanced brace pair — followed immediately by the CLI's own JSON
  // payload on the same physical line. A cap on the number of `{`
  // candidates tried per line (64, tried left to right) exhausted itself on
  // the 70 preceding groups before ever reaching the payload's own `{`,
  // producing a false "kstep-cli produced no output" invocation error for
  // an otherwise-successful render. The current right-to-left,
  // balance-based scan never even looks at these 70 groups: it starts at
  // the line's trailing `}` and stops as soon as its own depth resolves to
  // 0, which happens at the payload's own opening `{` — long before the
  // scan would reach index 0.
  const nodeNoise = Array.from({ length: 70 }, (_, i) => `{node ${i}}`).join("");
  const payload =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":11}';
  const stdout = nodeNoise + payload;
  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to find the payload despite 70 preceding balanced brace groups");
  assert.equal(json.rootCount, 11);
});

// ── extractJson: MAX_TOTAL_SCAN_CHARS budget accounting (MAJOR regression
// fix — the budget used to be charged BEFORE the candidate line was
// examined, so any payload sharing a line with >2 MiB of preceding user
// output was skipped unexamined even though the line itself carried the
// real, valid payload) ──────────────────────────────────────────────────

test("extractJson: finds a valid payload even when its own line is well over the 2 MiB budget (MAJOR regression fix)", () => {
  // The exact shape from the finding: a user script's own `print` output
  // shares a single physical line with the CLI's JSON payload, and that
  // combined line is bigger than MAX_TOTAL_SCAN_CHARS on its own. Charging
  // the budget up front (a prior version of this function did) discarded
  // the line — and therefore the payload — without ever calling
  // `findJsonObjectStart` on it. The budget must only gate *further* lines,
  // never the one actually being examined.
  const payload =
    '{"status":"success","command":"render","outPath":"/tmp/out","format":"text","content":"summary",' +
    '"fallback":false,"geometry":{"detected":false,"shapeCount":0},"occt":{"available":true,"version":"1"},"rootCount":42}';
  const userNoise = "x".repeat(3 * 1024 * 1024); // 3 MiB, over the 2 MiB budget on its own
  const stdout = userNoise + payload;

  const json = extractJson(stdout);
  assert.ok(json, "expected extractJson to still find the payload on an over-budget line");
  assert.equal(json.rootCount, 42);
});

test("extractJson: a buffer of many short no-payload candidate lines still returns null within a time bound (MINOR DoS hardening)", () => {
  // Each line is short (`{,}` — 3 chars), so the character-only budget from
  // the MAJOR fix above would allow roughly 700,000 JSON.parse throws
  // before giving up; CANDIDATE_LINE_OVERHEAD caps the number of lines
  // examined (and therefore JSON.parse attempts) independently of their
  // length, to roughly MAX_TOTAL_SCAN_CHARS / CANDIDATE_LINE_OVERHEAD.
  const stdout = Array.from({ length: 1_400_000 }, () => "{,}").join("\n");

  const start = Date.now();
  const json = extractJson(stdout);
  const elapsedMs = Date.now() - start;

  assert.equal(json, null);
  assert.ok(elapsedMs < 3000, `expected extractJson to give up well under 3s, took ${elapsedMs}ms`);
});

// ── extractJson: structural validation of diagnostics/violations array
// ELEMENTS, not just the array itself (MINOR finding — isValidKStepJson
// checked Array.isArray but not each element's shape, so a `null` element
// parsed as valid and later crashed KStepCard.renderCliError) ────────────

test("extractJson: rejects a compilation_error payload whose diagnostics array contains null", () => {
  const stdout = '{"status":"error","errorKind":"compilation_error","code":"X","diagnostics":[null]}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: rejects a validation_failed payload whose violations array contains null", () => {
  const stdout = '{"status":"error","errorKind":"validation_failed","violations":[null]}';
  assert.equal(extractJson(stdout), null);
});

test("extractJson: still accepts a compilation_error payload whose diagnostics are well-formed objects", () => {
  const stdout =
    '{"status":"error","errorKind":"compilation_error","code":"X",' +
    '"diagnostics":[{"severity":"ERROR","message":"oops","line":1,"column":2}]}';
  const json = extractJson(stdout);
  assert.ok(json);
  assert.equal(json.diagnostics[0].message, "oops");
});

test("filterStderr: strips WARNING/SLF4J/INFO/Wrote noise lines but keeps real content", () => {
  const stderr = [
    "WARNING: sun.misc.Unsafe::objectFieldOffset is not supported",
    "SLF4J(W): No SLF4J providers were found.",
    "[main] INFO some.package - noisy info",
    "",
    "  ",
    "Wrote 4096 bytes to /tmp/out",
    "Actual failure line",
  ].join("\n");
  assert.equal(filterStderr(stderr), "Actual failure line");
});

test("filterStderr: handles empty and nullish input without throwing", () => {
  assert.equal(filterStderr(""), "");
  assert.equal(filterStderr(undefined), "");
  assert.equal(filterStderr(null), "");
});

// ── renderViaCli: script-size guard (MINOR finding — no limit on the block
// written to a temp file and handed to the JVM) ────────────────────────────

test("renderViaCli: rejects an oversized script before ever touching the filesystem or the CLI", async () => {
  const oversized = "x".repeat(1024 * 1024 + 1); // MAX_SCRIPT_BYTES + 1
  // Deliberately an invalid cliPath — if the size check didn't short-circuit
  // before execFile, this would instead come back as an ENOENT
  // invocationError, not the "too large" one asserted below.
  const result = await renderViaCli(oversized, "/definitely/does/not/exist/kstep-cli");
  assert.equal(result.kind, "invocationError");
  assert.match(result.title, /too large/i);
});

test("renderViaCli: a script at exactly MAX_SCRIPT_BYTES is not rejected for size (off-by-one check)", async () => {
  const exactly = "x".repeat(1024 * 1024);
  const result = await renderViaCli(exactly, FAKE_CLI);
  assert.equal(
    result.kind,
    "geometry",
    `expected a script of exactly MAX_SCRIPT_BYTES to pass the size guard, got: ${JSON.stringify(result).slice(0, 200)}`,
  );
});

// ── renderViaCli: output-size guard (MAJOR finding — unbounded read of the
// CLI's output FILE, independent of the bounded stdout maxBuffer) ─────────

test("renderViaCli: a small CLI output renders normally (fake-CLI harness sanity check)", async () => {
  const result = await renderViaCli('println("hi")', FAKE_CLI);
  assert.equal(result.kind, "geometry");
  assert.ok(result.svg.includes("<svg"));
});

test("renderViaCli: rejects a CLI output file over MAX_OUTPUT_BYTES instead of reading it whole into memory", async () => {
  const prevEnv = process.env.FAKE_KSTEP_OUTPUT_BYTES;
  process.env.FAKE_KSTEP_OUTPUT_BYTES = String(9 * 1024 * 1024); // over the 8 MiB limit
  try {
    const result = await renderViaCli('println("hi")', FAKE_CLI);
    assert.equal(result.kind, "invocationError");
    assert.match(result.title, /too large/i);
  } finally {
    if (prevEnv === undefined) delete process.env.FAKE_KSTEP_OUTPUT_BYTES;
    else process.env.FAKE_KSTEP_OUTPUT_BYTES = prevEnv;
  }
});

// ── renderGlbViaCli (MAJOR testability finding, this wave's review — this
// function had zero unit tests: only scripts/smoke-test.mjs exercised it,
// and that script deliberately does NOT run in CI (needs a real kstep-cli
// JVM install). test/helpers/fakeKstepCli.mjs's `-f glb` branch (added this
// wave) lets these tests exercise the same real-child-process path
// `renderViaCli`'s tests above already use, for the `-f glb` guards that are
// this function's own: MAX_GLB_BYTES, the `json.format !== "glb"` rejection,
// the outPath mismatch check, and — most importantly — the
// Buffer→ArrayBuffer copy documented as a security-relevant guard in this
// function's own doc comment (Node's `Buffer.buffer` can point into a
// SHARED pool ArrayBuffer for small allocations). ────────────────────────

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

test("renderGlbViaCli: a small GLB output renders normally (fake-CLI harness sanity check)", async () => {
  const result = await renderGlbViaCli('println("hi")', FAKE_CLI);
  assert.equal(result.kind, "geometry3d");
  assert.equal(result.json.format, "glb");
  assert.equal(result.json.status, "success");
});

test("renderGlbViaCli: copies the CLI output out of Node's (possibly shared-pool) Buffer, not merely aliases it (MAJOR security regression guard)", async () => {
  // Deliberately well under Node's default Buffer pool size (8 KiB) — this is
  // exactly the size class for which `fs.readFileSync` backs its returned
  // Buffer with a slice of a larger, SHARED pool ArrayBuffer. If
  // `renderGlbViaCli` ever regressed to handing back `buf.buffer` directly
  // (instead of `buf.buffer.slice(buf.byteOffset, buf.byteOffset +
  // buf.byteLength)`, per its own doc comment), the returned ArrayBuffer's
  // `byteLength` here would silently balloon to the pool's own size (or
  // whatever remained of it) instead of staying exactly 32 — and, far worse
  // in a real Obsidian session, `GLTFLoader.parse` would receive unrelated
  // bytes from neighbouring allocations sharing that same pool.
  const result = await withEnv("FAKE_KSTEP_GLB_BYTES", "32", () => renderGlbViaCli('println("hi")', FAKE_CLI));
  assert.equal(result.kind, "geometry3d");
  assert.equal(result.glb.byteLength, 32, "the returned ArrayBuffer must be exactly the file's own size, not a shared pool's");
  const bytes = new Uint8Array(result.glb);
  assert.ok(
    bytes.every((b) => b === 0x2a),
    "every byte must be the fake CLI's own fill value — no unrelated pool bytes leaking in",
  );
});

test("renderGlbViaCli: rejects a GLB output file over MAX_GLB_BYTES instead of reading it whole into memory", async () => {
  const result = await withEnv("FAKE_KSTEP_GLB_BYTES", String(17 * 1024 * 1024), () =>
    renderGlbViaCli('println("hi")', FAKE_CLI),
  );
  assert.equal(result.kind, "invocationError");
  assert.match(result.title, /too large/i);
});

test("renderGlbViaCli: a GLB output at exactly MAX_GLB_BYTES is not rejected for size (off-by-one check)", async () => {
  const result = await withEnv("FAKE_KSTEP_GLB_BYTES", String(16 * 1024 * 1024), () =>
    renderGlbViaCli('println("hi")', FAKE_CLI),
  );
  assert.equal(
    result.kind,
    "geometry3d",
    `expected a GLB of exactly MAX_GLB_BYTES to pass the size guard, got: ${JSON.stringify(result).slice(0, 200)}`,
  );
});

test("renderGlbViaCli: rejects a response whose own format field is not \"glb\"", async () => {
  const result = await withEnv("FAKE_KSTEP_GLB_WRONG_FORMAT", "1", () => renderGlbViaCli('println("hi")', FAKE_CLI));
  assert.equal(result.kind, "invocationError");
  assert.match(result.title, /unexpected format/i);
});

test("renderGlbViaCli: rejects a response whose outPath does not match the requested output path", async () => {
  const result = await withEnv("FAKE_KSTEP_GLB_WRONG_OUTPATH", "1", () =>
    renderGlbViaCli('println("hi")', FAKE_CLI),
  );
  assert.equal(result.kind, "invocationError");
  assert.match(result.title, /unexpected output path/i);
});

test("renderGlbViaCli: rejects an oversized script before ever touching the filesystem or the CLI", async () => {
  const oversized = "x".repeat(1024 * 1024 + 1); // MAX_SCRIPT_BYTES + 1
  const result = await renderGlbViaCli(oversized, "/definitely/does/not/exist/kstep-cli");
  assert.equal(result.kind, "invocationError");
  assert.match(result.title, /too large/i);
});
