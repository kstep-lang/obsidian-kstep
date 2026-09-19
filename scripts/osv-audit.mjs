#!/usr/bin/env node
// Dependency vulnerability check against the OSV database (https://osv.dev), independent of the npm registry.
//
// Why: `npm audit` needs the npm registry's audit endpoint. When that endpoint is unreachable or retired for
// the installed npm version, or the registry is down for maintenance, the release gate "no known dependency
// vulnerabilities" cannot be met. This script reads package-lock.json and queries osv.dev instead.
// No dependencies, Node >= 18.
//
// Usage:  node scripts/osv-audit.mjs [--prod] [path/to/package-lock.json]
//   --prod   ignore devDependencies (only packages that end up in the build's runtime dependency tree)
// Exit code: 0 = no advisories, 1 = advisories found, 2 = the check itself failed (network/parse error).
// A failed check is NOT a pass -- do not treat exit code 2 as green. An empty lockfile is also a failure.
// Limits: no severity levels or thresholds (any OSV advisory, including malware entries, counts); packages that
// resolve to git/file sources are unknown to OSV and silently yield no result; `devOptional` packages are
// reported as prod and therefore stay in --prod runs (conservative).
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`osv-audit: ${message}`);
  process.exit(2);
}
process.on("uncaughtException", (e) => fail(`unexpected error: ${e.message}`));

const args = process.argv.slice(2);
const unknownOptions = args.filter((a) => a.startsWith("--") && a !== "--prod");
if (unknownOptions.length > 0) fail(`unknown option ${unknownOptions.join(", ")}`);
const prodOnly = args.includes("--prod");
const lockPath = args.find((a) => !a.startsWith("--")) ?? "package-lock.json";
const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const CHUNK_SIZE = 500;

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (e) {
  fail(`cannot read ${lockPath}: ${e.message}`);
}
if (!lock || typeof lock.packages !== "object" || lock.packages === null) {
  fail(`${lockPath} has no "packages" map (lockfileVersion >= 2 required)`);
}

const seen = new Map();
const packages = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (path === "" || !info || info.link || !info.version) continue;
  if (prodOnly && info.dev) continue;
  // Workspace packages have no node_modules/ segment in their path; their path is not a registry name.
  if (!path.includes("node_modules/") && !info.name) continue;
  const name = info.name ?? path.split("node_modules/").pop();
  const key = `${name}@${info.version}`;
  const dev = Boolean(info.dev);
  const existing = seen.get(key);
  if (existing) {
    existing.dev = existing.dev && dev; // listed as dev only if every occurrence is dev
    continue;
  }
  const entry = { name, version: info.version, dev };
  seen.set(key, entry);
  packages.push(entry);
}
if (packages.length === 0) fail("no installable packages found in lockfile -- refusing to report green");

async function queryChunk(chunk) {
  const response = await fetch(OSV_BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`OSV answered HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.results) || body.results.length !== chunk.length) {
    throw new Error("unexpected OSV response shape");
  }
  // A truncated result list is not handled (fail closed rather than risk a false green).
  if (body.results.some((r) => r.next_page_token)) throw new Error("OSV paginated a result (next_page_token)");
  return body.results;
}

const findings = [];
try {
  for (let i = 0; i < packages.length; i += CHUNK_SIZE) {
    const chunk = packages.slice(i, i + CHUNK_SIZE);
    const results = await queryChunk(chunk);
    results.forEach((result, index) => {
      for (const vuln of result.vulns ?? []) findings.push({ ...chunk[index], id: vuln.id });
    });
  }
} catch (e) {
  fail(`OSV query failed: ${e.message}`);
}

console.log(`osv-audit: checked ${packages.length} packages${prodOnly ? " (prod only)" : ""} against osv.dev`);
if (findings.length === 0) {
  console.log("osv-audit: 0 known advisories");
  process.exit(0);
}
console.log(`osv-audit: ${findings.length} advisories found`);
for (const f of findings) {
  console.log(`  ${f.name}@${f.version} (${f.dev ? "dev" : "prod"})  ${f.id}  https://osv.dev/${f.id}`);
}
process.exit(1);
