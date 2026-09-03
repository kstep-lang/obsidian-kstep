import esbuild from "esbuild";
import process from "process";
// Use Node's own list of builtin modules instead of the deprecated
// `builtin-modules` npm package (flagged by the Obsidian plugin reviewer).
import { builtinModules as builtins } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
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
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  // Only for production: a dev build stays unminified so a stack trace from
  // `npm run dev`'s watch mode points at readable source. Matters far more
  // than it used to since this wave bundled `three` + GLTFLoader +
  // OrbitControls — minification is what keeps the shipped main.js close to
  // the report's own measured ~608 KB for three.js alone, rather than the
  // ~1.3 MB an unminified bundle of the whole plugin actually is (verified
  // this wave: minification alone took it from 1,368,577 B to well under
  // release.yml's revised size gate — see that file's own comment for the
  // exact before/after numbers).
  minify: prod,
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
