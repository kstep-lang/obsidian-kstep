import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers/loadModule.mjs";

const { cacheKey, RenderCache, ConcurrencyGate } = await loadModule("src/KStepScheduler.ts");

// ── cacheKey ─────────────────────────────────────────────────────────────

test("cacheKey: the NUL separator prevents ambiguous concatenations from colliding", () => {
  assert.notEqual(cacheKey("ab", "c"), cacheKey("a", "bc"));
});

test("cacheKey: is deterministic for the same inputs", () => {
  assert.equal(cacheKey("/bin/kstep-cli", "model(\"x\") {}"), cacheKey("/bin/kstep-cli", 'model("x") {}'));
});

// ── RenderCache (LRU) ────────────────────────────────────────────────────

test("RenderCache: get/set roundtrip, missing key returns undefined", () => {
  const cache = new RenderCache(2);
  const value = { kind: "summary", text: "A" };
  cache.set("k1", value);
  assert.equal(cache.get("k1"), value);
  assert.equal(cache.get("missing"), undefined);
});

test("RenderCache: evicts the least-recently-used entry once over capacity", () => {
  const cache = new RenderCache(2);
  cache.set("k1", { v: 1 });
  cache.set("k2", { v: 2 });
  cache.set("k3", { v: 3 }); // k1 is oldest and untouched — evicted
  assert.equal(cache.get("k1"), undefined);
  assert.deepEqual(cache.get("k2"), { v: 2 });
  assert.deepEqual(cache.get("k3"), { v: 3 });
});

test("RenderCache: get() touches an entry, protecting it from the next eviction", () => {
  const cache = new RenderCache(2);
  cache.set("k1", { v: 1 });
  cache.set("k2", { v: 2 });
  cache.get("k1"); // k1 now most-recently-used — k2 becomes the eviction candidate
  cache.set("k3", { v: 3 });
  assert.deepEqual(cache.get("k1"), { v: 1 });
  assert.equal(cache.get("k2"), undefined);
  assert.deepEqual(cache.get("k3"), { v: 3 });
});

test("RenderCache: re-setting an existing key updates it without evicting anything", () => {
  const cache = new RenderCache(2);
  cache.set("k1", { v: 1 });
  cache.set("k2", { v: 2 });
  cache.set("k1", { v: 11 });
  assert.deepEqual(cache.get("k1"), { v: 11 });
  assert.deepEqual(cache.get("k2"), { v: 2 });
});

test("RenderCache: clear() empties the cache", () => {
  const cache = new RenderCache(2);
  cache.set("k1", { v: 1 });
  cache.set("k2", { v: 2 });
  cache.clear();
  assert.equal(cache.get("k1"), undefined);
  assert.equal(cache.get("k2"), undefined);
});

// ── RenderCache byte-budget eviction (MAJOR finding — entry-count cap alone
// does not bound memory: a `geometry`/`summary`/`notice` result's `svg`/
// `text` field can be up to MAX_OUTPUT_BYTES each) ─────────────────────────

test("RenderCache: evicts oldest-first once the byte budget is exceeded, even under the entry-count cap", () => {
  // maxBytes small enough that two ~40-byte entries don't both fit.
  const cache = new RenderCache(10, 50);
  cache.set("k1", { kind: "summary", text: "a".repeat(30) });
  cache.set("k2", { kind: "summary", text: "b".repeat(30) });
  assert.equal(cache.get("k1"), undefined, "expected k1 to be evicted by the byte budget, not the count cap");
  assert.ok(cache.get("k2"), "expected k2 (most recently set) to survive");
});

test("RenderCache: a large single entry does not permanently wedge the cache once it ages out", () => {
  const cache = new RenderCache(10, 100);
  cache.set("k1", { kind: "summary", text: "a".repeat(80) });
  cache.set("k2", { kind: "summary", text: "b" }); // tiny — should fit alongside k1
  assert.ok(cache.get("k1"));
  assert.ok(cache.get("k2"));
  cache.set("k3", { kind: "summary", text: "c".repeat(80) }); // forces eviction to make room
  assert.equal(cache.get("k1"), undefined, "expected the oldest large entry to be evicted for the new one");
  assert.ok(cache.get("k3"));
});

test("RenderCache: byte accounting is unaffected by non-KStepRenderResult-shaped test values (no crash, default cost)", () => {
  // Several existing tests in this file pass plain `{ v: n }` objects rather
  // than real KStepRenderResult shapes — estimateBytes must degrade to 0 for
  // those (via its `default` branch on `.kind`) rather than throwing.
  const cache = new RenderCache(2, 10);
  assert.doesNotThrow(() => cache.set("k1", { v: 1 }));
});

// ── ConcurrencyGate ──────────────────────────────────────────────────────

test("ConcurrencyGate: runs at most `limit` tasks concurrently, queueing the rest", async () => {
  const gate = new ConcurrencyGate(2);
  let active = 0;
  let maxActive = 0;

  async function task(id) {
    return gate.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return id;
    });
  }

  const results = await Promise.all([1, 2, 3, 4].map(task));
  assert.deepEqual(results, [1, 2, 3, 4]);
  assert.ok(maxActive <= 2, `expected at most 2 concurrent tasks, saw ${maxActive}`);
});

test("ConcurrencyGate: admits queued tasks in FIFO order", async () => {
  const gate = new ConcurrencyGate(1);
  const startOrder = [];

  async function task(id) {
    return gate.run(async () => {
      startOrder.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return id;
    });
  }

  await Promise.all([1, 2, 3].map(task));
  assert.deepEqual(startOrder, [1, 2, 3]);
});

test("ConcurrencyGate: releases its slot even when the task throws", async () => {
  const gate = new ConcurrencyGate(1);
  await assert.rejects(
    () =>
      gate.run(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  // If the slot weren't released on the throw path, this second call would
  // hang forever — the test's own timeout is the real assertion here.
  const result = await gate.run(async () => "ok");
  assert.equal(result, "ok");
});
