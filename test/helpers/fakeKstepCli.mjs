#!/usr/bin/env node
// Minimal stand-in for kstep-cli's `render <in> -f <fmt> -o <out> --output
// json` contract, used only by test/kstep-cli-renderer.test.mjs to exercise
// src/KStepCliRenderer.ts's *output-handling* logic (the MAX_OUTPUT_BYTES /
// MAX_GLB_BYTES guards) against a real child process, without depending on a
// real kSTEP CLI build being available on this machine. Branches on the `-f`
// argument's value: `-f glb` (renderGlbViaCli's forced format) writes
// arbitrary binary bytes and a `format: "glb"` payload; anything else (the
// `-f auto` renderViaCli always passes) keeps this script's original SVG
// behaviour unchanged.
//
// Controlled via environment variables so the same script can drive
// different scenarios from different tests:
//
//   FAKE_KSTEP_OUTPUT_BYTES — approximate size (in bytes) of the `-f auto`
//                             SVG file written to the path given after `-o`.
//                             Omit for a small, valid SVG.
//   FAKE_KSTEP_GLB_BYTES    — approximate size (in bytes) of the `-f glb`
//                             file written to the path given after `-o`.
//                             Omit for a small, arbitrary buffer — its
//                             CONTENTS are never a real GLB container (no
//                             caller of this fake CLI in
//                             test/kstep-cli-renderer.test.mjs exercises
//                             GLB-structure validation, which is
//                             src/KStepGlb.ts's `validateGlb`, not
//                             `renderGlbViaCli`'s own concern — see that
//                             function's doc comment).
//   FAKE_KSTEP_GLB_WRONG_FORMAT — if set, the `-f glb` payload's own
//                             "format" field lies and says "svg" instead —
//                             simulates a misbehaving CLI, for
//                             `renderGlbViaCli`'s `json.format !== "glb"`
//                             guard.
//   FAKE_KSTEP_GLB_WRONG_OUTPATH — if set, the `-f glb` payload's "outPath"
//                             field points somewhere other than the real
//                             `-o` path — for `renderGlbViaCli`'s
//                             outPath-mismatch guard.
import fs from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("-o");
const outFile = args[outIdx + 1];
const fIdx = args.indexOf("-f");
const format = fIdx !== -1 ? args[fIdx + 1] : "auto";

if (format === "glb") {
  const requestedBytes = process.env.FAKE_KSTEP_GLB_BYTES ? Number(process.env.FAKE_KSTEP_GLB_BYTES) : null;
  const size = requestedBytes !== null ? Math.max(0, requestedBytes) : 32;
  fs.writeFileSync(outFile, Buffer.alloc(size, 0x2a));

  const payload = {
    status: "success",
    command: "render",
    outPath: process.env.FAKE_KSTEP_GLB_WRONG_OUTPATH ? `${outFile}.wrong` : outFile,
    format: process.env.FAKE_KSTEP_GLB_WRONG_FORMAT ? "svg" : "glb",
    content: "geometry",
    fallback: false,
    geometry: { detected: true, shapeCount: 1 },
    occt: { available: true, version: "fake" },
    rootCount: 1,
    glb: { triangleCount: 12, vertexCount: 8, droppedTriangleCount: 0, byteLength: size },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
  const requestedBytes = process.env.FAKE_KSTEP_OUTPUT_BYTES ? Number(process.env.FAKE_KSTEP_OUTPUT_BYTES) : null;

  const content =
    requestedBytes !== null
      ? `<svg>${"x".repeat(Math.max(0, requestedBytes - "<svg></svg>".length))}</svg>`
      : '<svg><polygon points="0,0 1,1 1,0"/></svg>';

  fs.writeFileSync(outFile, content, "utf-8");

  const payload = {
    status: "success",
    command: "render",
    outPath: outFile,
    format: "svg",
    content: "geometry",
    fallback: false,
    geometry: { detected: true, shapeCount: 1 },
    occt: { available: true, version: "fake" },
    rootCount: 1,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
