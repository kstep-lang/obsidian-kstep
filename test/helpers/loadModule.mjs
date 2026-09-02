import esbuild from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);

/**
 * Bundles a TypeScript module with esbuild and `require()`s the result — the
 * same technique scripts/smoke-test.mjs already uses to load
 * KStepCliRenderer.ts. Reused here so the unit tests need no ts-node/jest/
 * babel dependency, just the esbuild devDependency the repo already has.
 *
 * Every module under test (KStepCliRenderer.ts, KStepCard.ts, KStepScheduler.ts)
 * is deliberately free of an `obsidian` import (see each file's own header
 * comment), which is exactly what makes bundling and requiring them headless
 * like this possible.
 */
export async function loadModule(relSourcePath) {
  const entry = path.join(repoRoot, relSourcePath);
  const name = relSourcePath.replace(/[\\/]/g, "_").replace(/\.ts$/, "");
  const outfile = path.join(repoRoot, "build", "test", `${name}.cjs`);

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });

  delete require.cache[require.resolve(outfile)];
  return require(outfile);
}
