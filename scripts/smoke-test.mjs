#!/usr/bin/env node
// End-to-end smoke test for src/KStepCliRenderer.ts against the real
// kstep-cli binary. No test framework — this is the hard minimum described
// in the implementation plan for this wave.
//
// Steps:
//   1. Bundle KStepCliRenderer.ts alone (it has no `obsidian` import, so this
//      is possible) to build/smoke/renderer.cjs via the esbuild JS API.
//   2. Require that bundle and run seven real invocations against kstep-cli.
//
// Usage:
//   node scripts/smoke-test.mjs
//   KSTEP_CLI=/path/to/kstep-cli KSTEP_FIXTURES=/path/to/fixtures node scripts/smoke-test.mjs

import esbuild from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Per-OS default kSTEP checkout location (see CLAUDE.md's OS-detection
// convention — macOS uses /Users/irakli/, Linux /home/irakli/; Windows has
// no default here since kSTEP hasn't been verified there yet, so
// KSTEP_CLI/KSTEP_FIXTURES are required on that platform). Both defaults are
// overridable so `npm run smoke` also works in CI or on any other machine.
const kstepHome = os.platform() === "darwin" ? "/Users/irakli/IdeaProjects/kSTEP" : "/home/irakli/IdeaProjects/kSTEP";

const CLI_PATH = process.env.KSTEP_CLI ?? path.join(kstepHome, "kstep-cli/build/install/kstep-cli/bin/kstep-cli");

const FIXTURES_DIR = process.env.KSTEP_FIXTURES ?? path.join(kstepHome, "kstep-tests/src/test/resources");

const bundleOutfile = path.join(repoRoot, "build", "smoke", "renderer.cjs");

console.log(`kSTEP CLI:  ${CLI_PATH}`);
console.log(`Fixtures:   ${FIXTURES_DIR}`);
console.log(`Bundle:     ${bundleOutfile}`);
console.log("");

await esbuild.build({
  entryPoints: [path.join(repoRoot, "src", "KStepCliRenderer.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundleOutfile,
  logLevel: "info",
});

const require = createRequire(import.meta.url);
// Bust require cache in case a previous run in the same process left an
// entry (not expected for a fresh process, but harmless to guard).
delete require.cache[require.resolve(bundleOutfile)];
const { renderViaCli } = require(bundleOutfile);

let failures = 0;
let passed = 0;

function check(label, condition, actualForLog) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}`);
    if (actualForLog !== undefined) {
      console.log(`        actual: ${actualForLog}`);
    }
    failures++;
  }
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function obsidianKstepTempDirs() {
  return fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith("obsidian-kstep-"));
}

async function main() {
  // Snapshot up front, not just "is the prefix present after the run": a
  // real Obsidian instance with this plugin installed (the exact manual-test
  // setup this README describes) can legitimately hold one of these
  // directories open while rendering a block at the same moment Case 6 runs,
  // which would otherwise be misreported as a leak from this script's own
  // Case 1-5 invocations.
  const preExistingTempDirs = new Set(obsidianKstepTempDirs());

  // ── Case 1 — geometry ────────────────────────────────────────────────────
  console.log("Case 1: hello-box.kstep.kts (geometry)");
  {
    const source = readFixture("hello-box.kstep.kts");
    const result = await renderViaCli(source, CLI_PATH);
    console.log(`  result.kind = ${result.kind}`);
    if (result.kind === "invocationError") console.log(`  detail: ${result.detail}`);
    check("kind === 'geometry'", result.kind === "geometry", result.kind);
    if (result.kind === "geometry") {
      check("svg contains <svg", result.svg.includes("<svg"));
      check("svg contains <polygon", result.svg.includes("<polygon"));
      check("json.format === 'svg'", result.json.format === "svg", result.json.format);
      check(
        "json.geometry.triangleCount > 0",
        typeof result.json.geometry.triangleCount === "number" && result.json.geometry.triangleCount > 0,
        result.json.geometry.triangleCount,
      );
    }
  }
  console.log("");

  // ── Case 2 — summary ─────────────────────────────────────────────────────
  console.log("Case 2: hello-assembly.kstep.kts (summary)");
  {
    const source = readFixture("hello-assembly.kstep.kts");
    const result = await renderViaCli(source, CLI_PATH);
    console.log(`  result.kind = ${result.kind}`);
    if (result.kind === "invocationError") console.log(`  detail: ${result.detail}`);
    check("kind === 'summary'", result.kind === "summary", result.kind);
    if (result.kind === "summary") {
      check("text contains 'Model'", result.text.includes("Model"));
      check("text contains 'geometry    none'", result.text.includes("geometry    none"));
      check("json.geometry.detected === false", result.json.geometry.detected === false, result.json.geometry.detected);
    }
  }
  console.log("");

  // ── Case 3 — notice (fallback) ───────────────────────────────────────────
  console.log("Case 3: hello-box-closed.kstep.kts (notice/fallback)");
  {
    const source = readFixture("hello-box-closed.kstep.kts");
    const result = await renderViaCli(source, CLI_PATH);
    console.log(`  result.kind = ${result.kind}`);
    if (result.kind === "invocationError") console.log(`  detail: ${result.detail}`);
    check("kind === 'notice'", result.kind === "notice", result.kind);
    if (result.kind === "notice") {
      check("json.fallback === true", result.json.fallback === true, result.json.fallback);
      check(
        "json.fallbackReason === 'shape_closed_by_script'",
        result.json.fallbackReason === "shape_closed_by_script",
        result.json.fallbackReason,
      );
    }
  }
  console.log("");

  // ── Case 4 — compilation error (Befund A: stdout parsed even on exit 1) ─
  console.log("Case 4: inline invalid Kotlin source (cliError / compilation_error)");
  {
    const source = "this is not valid kotlin (((";
    const result = await renderViaCli(source, CLI_PATH);
    console.log(`  result.kind = ${result.kind}`);
    if (result.kind === "invocationError") console.log(`  detail: ${result.detail}`);
    check("kind === 'cliError'", result.kind === "cliError", result.kind);
    if (result.kind === "cliError") {
      check(
        "json.errorKind === 'compilation_error'",
        result.json.errorKind === "compilation_error",
        result.json.errorKind,
      );
      if (result.json.errorKind === "compilation_error") {
        check("diagnostics.length > 0", result.json.diagnostics.length > 0, result.json.diagnostics.length);
      }
    }
  }
  console.log("");

  // ── Case 5 — CLI not found ───────────────────────────────────────────────
  console.log("Case 5: nonexistent CLI path (invocationError)");
  {
    const source = readFixture("hello-box.kstep.kts");
    const result = await renderViaCli(source, "kstep-definitely-not-here");
    console.log(`  result.kind = ${result.kind}`);
    check("kind === 'invocationError'", result.kind === "invocationError", result.kind);
    if (result.kind === "invocationError") {
      check("title mentions 'not found'", result.title.toLowerCase().includes("not found"), result.title);
      check("detail mentions 'kstep-cli'", result.detail.includes("kstep-cli"), result.detail);
    }
  }
  console.log("");

  // ── Case 6b — geometry, but the script's own stdout has no trailing
  // newline before the CLI's JSON payload (Round 3 CRITICAL regression) ───
  console.log("Case 6b: hello-box.kstep.kts with a leading print() (no trailing newline)");
  {
    // Kotlin's `print` (unlike `println`) leaves no newline behind, so the
    // CLI's own JSON payload ends up sharing a stdout LINE with this
    // script's own output instead of starting a fresh line. extractJson
    // must still find it — see src/KStepCliRenderer.ts's extractJson doc
    // comment and the Round-3 regression tests in
    // test/kstep-cli-renderer.test.mjs for the unit-level version of this
    // same scenario.
    const source = 'print("progress: ")\nrepeat(3) { print(".") }\n' + readFixture("hello-box.kstep.kts");
    const result = await renderViaCli(source, CLI_PATH);
    console.log(`  result.kind = ${result.kind}`);
    if (result.kind === "invocationError") console.log(`  detail: ${result.detail}`);
    check("kind === 'geometry' (not invocationError)", result.kind === "geometry", result.kind);
    if (result.kind === "geometry") {
      check("svg contains <svg", result.svg.includes("<svg"));
    }
  }
  console.log("");

  // ── Case 6 — temp-directory leak check ───────────────────────────────────
  console.log("Case 6: no leftover obsidian-kstep-* temp directories");
  {
    // Only entries that appeared during THIS run and are still there count
    // as a leak from renderViaCli — pre-existing ones belong to something
    // else (see the snapshot comment above main()).
    const leaked = obsidianKstepTempDirs().filter((e) => !preExistingTempDirs.has(e));
    check("no leaked temp dirs", leaked.length === 0, leaked.join(", "));
  }
  console.log("");

  console.log(`${passed} passed, ${failures} failed`);
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
