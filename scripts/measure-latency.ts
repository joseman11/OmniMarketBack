/**
 * Sequential latency probe: `npm run measure:latency -- <url> [calls=10]`.
 * Sends the calls one after the other (never in parallel) and reports every status and duration plus p50/p95,
 * measured on the client, so the numbers include network and any cold start. Exits with 1 if a call is not 2xx.
 */
const [url, rawCalls = "10"] = process.argv.slice(2);
const calls = Number(rawCalls);

if (!url || !/^https?:\/\//.test(url) || !Number.isInteger(calls) || calls < 1) {
  console.error("Usage: npm run measure:latency -- <http(s) URL> [calls=10]");
  process.exit(2);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const durations: number[] = [];
let failed = false;
for (let call = 1; call <= calls; call += 1) {
  const startedAt = performance.now();
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  await response.arrayBuffer();
  const elapsed = performance.now() - startedAt;
  durations.push(elapsed);
  failed ||= !response.ok;
  // x-vercel-cache tells a CDN hit (HIT/STALE) from a function invocation (MISS/BYPASS).
  const cache = response.headers.get("x-vercel-cache");
  console.log(`#${String(call).padStart(2)}  ${response.status}  ${elapsed.toFixed(1).padStart(8)} ms${cache ? `  x-vercel-cache=${cache}` : ""}`);
}

const sorted = [...durations].sort((a, b) => a - b);
console.log(`\n${calls} calls to ${url}`);
console.log(`p50 ${percentile(sorted, 50).toFixed(1)} ms · p95 ${percentile(sorted, 95).toFixed(1)} ms · min ${sorted[0]!.toFixed(1)} ms · max ${sorted.at(-1)!.toFixed(1)} ms`);
if (failed) process.exitCode = 1;
