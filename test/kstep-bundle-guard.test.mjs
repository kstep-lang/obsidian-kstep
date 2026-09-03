import { test } from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules as builtins } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/**
 * Rebuilds main.js with production settings (mirrors esbuild.config.mjs
 * exactly, minus writing to the real outfile) and scans the resulting bundle
 * text for `http(s)://` hosts. Catches a regression that would ship a
 * network-fetching dependency in this plugin's bundle — see the
 * implementation report's §3.2 for why this is a host ALLOWLIST, not a bare
 * "no http(s)" regex: `jcgt.org` is a real, harmless match that lives inside
 * a GLSL shader source STRING in three.js's own code (a paper citation
 * comment) and survives minification; `www.w3.org` is the XHTML namespace
 * URI three.js's SVG-ish helpers reference. Neither is ever fetched at
 * runtime — this test's job is to catch a NEW host appearing, not to purge
 * these two known-inert ones.
 */
async function buildBundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, "main.ts")],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtins,
    ],
    format: "cjs",
    target: "es2018",
    minify: true,
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const ALLOWED_HOSTS = new Set(["www.w3.org", "jcgt.org"]);

// Hosts that must NEVER appear in the bundle, checked explicitly (and with
// their own, sprechende failure message) rather than left to fall out of an
// "anything not on the allowlist" diff — this is exactly the set of hosts
// `model-viewer`'s bundle was found to embed as runtime constants during
// this wave's library-choice investigation (see report §1), and the reason
// three.js was chosen over it.
const FORBIDDEN_HOST_SUBSTRINGS = ["gstatic.com", "jsdelivr.net", "unpkg.com", "esm.sh", "githubusercontent.com"];

test("bundle guard: no http(s) host outside the allowlist appears in the built main.js", async () => {
  const bundle = await buildBundle();

  for (const forbidden of FORBIDDEN_HOST_SUBSTRINGS) {
    assert.ok(
      !bundle.includes(forbidden),
      `Bundle contains the forbidden host substring "${forbidden}" — a runtime network-fetch dependency slipped in.`,
    );
  }

  const hostRe = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  const foundHosts = new Set();
  let match;
  while ((match = hostRe.exec(bundle)) !== null) {
    foundHosts.add(match[1].toLowerCase());
  }

  const unexpected = [...foundHosts].filter((h) => !ALLOWED_HOSTS.has(h));
  assert.deepEqual(unexpected, [], `Unexpected http(s) host(s) in bundle: ${unexpected.join(", ")}`);
});

test("bundle guard: no new Function( in the built main.js", async () => {
  const bundle = await buildBundle();
  assert.ok(!/new Function\(/.test(bundle), "Bundle must never construct a Function from a string.");
});
