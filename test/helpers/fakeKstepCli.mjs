#!/usr/bin/env node
// Minimal stand-in for kstep-cli's `render <in> -f auto -o <out> --output
// json` contract, used only by test/kstep-cli-renderer.test.mjs to exercise
// src/KStepCliRenderer.ts's *output-handling* logic (the MAX_OUTPUT_BYTES
// guard) against a real child process, without depending on a real kSTEP CLI
// build being available on this machine.
//
// Controlled via one environment variable so the same script can drive
// different scenarios from different tests:
//
//   FAKE_KSTEP_OUTPUT_BYTES — approximate size (in bytes) of the file
//                             written to the path given after `-o`. Omit for
//                             a small, valid SVG.
import fs from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("-o");
const outFile = args[outIdx + 1];

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
