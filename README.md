# obsidian-kstep

Obsidian Community Plugin that renders `kstep` code blocks — kSTEP model
scripts (`.kstep.kts`) — as inline previews:

- an isometric SVG when the model has geometry,
- a formatted product-structure card when it does not (e.g. an assembly of
  parts with no shapes of its own),
- a text fallback with a clear explanation when geometry exists but could not
  be rendered this run (e.g. OCCT unavailable, or the shape was closed by the
  script before rendering),
- a structured error card (with line/column or rule-violation detail) when
  the script fails to compile or fails model validation.

Analogous in spirit to [obsidian-kuml](https://github.com/kuml-dev/obsidian-kuml),
but rendering [kSTEP](https://kstep.dev) (ISO 10303 / STEP) models via the
[`kstep-cli`](https://github.com/kstep-lang/kSTEP) binary instead of kUML
diagrams.

## Status

Early scaffold (V0.1.0). Desktop-only — `kstep-cli` runs on the JVM, so this
plugin is not available on mobile. Not yet published to the Community Plugin
store.

## Security

> [!WARNING]
> A `kstep` code block is a **complete Kotlin script**, executed on your
> machine via `kstep-cli` when the note is rendered — including file and
> network access. This plugin does **not** sandbox script execution. Only
> open notes containing `kstep` blocks from sources you trust.

## Setup

1. Build `kstep-cli` (see the [kSTEP repo](https://github.com/kstep-lang/kSTEP))
   or install it via a package manager once available.
2. Install this plugin (see Development below for a local link) and set the
   **CLI path** in Settings → kSTEP Models to the `kstep-cli` binary.
3. Add a `kstep` code block to a note:

   ````
   ```kstep
   // your kSTEP model script
   ```
   ````

## Development

```bash
npm install
npm run dev       # esbuild watch mode
npm run build      # production bundle (main.js)
npm run typecheck  # tsc --noEmit
npm test           # unit tests (node:test, no CLI required)
npm run smoke      # end-to-end test against a real kstep-cli binary
```

`typecheck`, `test`, and `build` run in CI on every push/PR (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)). `smoke` does not —
it needs a real `kstep-cli` JVM binary on the runner, so it stays a manual,
local step.

Link into a vault for manual testing:

```bash
mkdir -p <vault>/.obsidian/plugins/kstep
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/kstep/
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
