import type { KStepRenderResult } from "./KStepResult";

const DEFAULT_CACHE_SIZE = 32;
const DEFAULT_CONCURRENCY = 2;

/**
 * Total byte budget for `RenderCache`, on top of its entry-count cap. Entry
 * *count* alone does not bound memory: a `geometry`/`summary`/`notice`
 * result's `svg`/`text` field is the CLI's output FILE read whole into a
 * string (see `KStepCliRenderer.ts`'s `MAX_OUTPUT_BYTES`, up to 8 MiB each),
 * so 32 large entries could otherwise sit in memory permanently (cleared
 * only by `saveSettings`, i.e. a settings change) — enough to noticeably
 * bloat, or with several large models, meaningfully strain Obsidian's
 * memory. `DEFAULT_MAX_CACHE_BYTES` (64 MiB) allows a full 32-entry cache of
 * *typical* small results with headroom to spare, while still evicting
 * oldest-first well before 32 near-`MAX_OUTPUT_BYTES` entries could
 * accumulate.
 */
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Rough byte size of a cached result — only the fields whose size scales
 * with the CLI's output are counted (`svg`/`text`; `json` and the
 * `cliError`/`invocationError` variants are tiny and fixed-shape by
 * comparison). Good enough for an eviction budget, not an exact accounting:
 * `.length` counts UTF-16 code units, not bytes — a JS engine's actual heap
 * cost for a string is roughly 2 bytes per code unit, so `DEFAULT_MAX_CACHE_BYTES`
 * (64 MiB of `.length`) corresponds to something closer to ~128 MiB of real
 * memory. That is still a perfectly adequate eviction budget for this
 * cache's purpose; this comment exists so the constant is never later read
 * as a precise memory ceiling.
 */
function estimateBytes(value: KStepRenderResult): number {
  switch (value.kind) {
    case "geometry":
      return value.svg.length;
    case "summary":
    case "notice":
      return value.text.length;
    default:
      return 0;
  }
}

/**
 * Cache key for a render result. Uses the CLI path and source verbatim
 * (concatenated with a NUL separator, which cannot appear in either string)
 * rather than a hash: the same information content, no collision risk (unlike
 * a probabilistic hash), and no `require("crypto")`.
 *
 * `\0` is written as an escape sequence deliberately, not as a raw NUL byte
 * in the source file — a literal NUL byte makes git treat this whole file as
 * binary (diffs, `git blame`, and `git grep` all degrade to "Binary files
 * differ"). esbuild emits the same `\0` escape in the bundled output either
 * way, so this changes nothing at runtime.
 */
export function cacheKey(cliPath: string, source: string): string {
  return `${cliPath}\0${source}`;
}

/**
 * Small LRU cache of render results, keyed by `cacheKey(cliPath, source)`.
 *
 * `invocationError` results (CLI not found, timeout, unexpected crash) are
 * deliberately never stored by callers — those are environment failures, not
 * a function of (cliPath, source), and caching one would leave a block stuck
 * showing a stale failure after the underlying problem is fixed, until the
 * note is reloaded.
 */
export class RenderCache {
  private readonly max: number;
  private readonly maxBytes: number;
  private readonly map = new Map<string, KStepRenderResult>();
  private bytes = 0;

  constructor(max: number = DEFAULT_CACHE_SIZE, maxBytes: number = DEFAULT_MAX_CACHE_BYTES) {
    this.max = max;
    this.maxBytes = maxBytes;
  }

  get(key: string): KStepRenderResult | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Touch: re-insert so it becomes most-recently-used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: KStepRenderResult): void {
    const cost = key.length + estimateBytes(value);

    if (this.map.has(key)) {
      this.bytes -= key.length + estimateBytes(this.map.get(key)!);
      this.map.delete(key);
    }

    // Evict oldest-first (count AND byte budget) before inserting — including
    // when the new entry alone would already exceed `maxBytes`, so a single
    // oversized result cannot wedge the cache at capacity forever without
    // ever being reachable again by future evictions.
    while (this.map.size > 0 && (this.map.size >= this.max || this.bytes + cost > this.maxBytes)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestValue = this.map.get(oldestKey)!;
      this.bytes -= oldestKey.length + estimateBytes(oldestValue);
      this.map.delete(oldestKey);
    }

    this.map.set(key, value);
    this.bytes += cost;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

/**
 * Bounds how many render tasks run concurrently (FIFO admission), so that a
 * note with many `kstep` blocks does not launch a JVM per block all at once.
 */
export class ConcurrencyGate {
  private readonly limit: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number = DEFAULT_CONCURRENCY) {
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
