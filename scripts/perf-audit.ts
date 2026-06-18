/**
 * Lighthouse performance audit against production.
 *
 * Usage:
 *   bun run scripts/perf-audit.ts [url]
 *
 * Runs mobile + desktop Lighthouse audits, prints a formatted report,
 * checks performance budgets, and saves raw JSON to docs/audits/.
 */

import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const url = process.argv[2] ?? "https://app.withpolaris.ai";

console.log("");
console.log(`  Running Lighthouse against ${url} ...`);

// --- Run Lighthouse ---

const tmpMobile = "/tmp/lighthouse-mobile.json";
const tmpDesktop = "/tmp/lighthouse-desktop.json";

execSync(
  `npx --yes lighthouse ${url} --only-categories=performance --output=json --output-path=${tmpMobile} --chrome-flags="--headless --no-sandbox" 2>/dev/null`,
  { stdio: "pipe" },
);

execSync(
  `npx lighthouse ${url} --only-categories=performance --preset=desktop --output=json --output-path=${tmpDesktop} --chrome-flags="--headless --no-sandbox" 2>/dev/null`,
  { stdio: "pipe" },
);

const m = JSON.parse(require("fs").readFileSync(tmpMobile, "utf-8"));
const d = JSON.parse(require("fs").readFileSync(tmpDesktop, "utf-8"));

// --- Extract metrics ---

function metric(report: any, key: string) {
  return report.audits[key];
}

const metrics = [
  { key: "first-contentful-paint", label: "First Contentful Paint", unit: "s", divisor: 1000 },
  { key: "largest-contentful-paint", label: "Largest Contentful Paint", unit: "s", divisor: 1000 },
  { key: "total-blocking-time", label: "Total Blocking Time", unit: "ms", divisor: 1 },
  { key: "cumulative-layout-shift", label: "Cumulative Layout Shift", unit: "", divisor: 1 },
  { key: "speed-index", label: "Speed Index", unit: "s", divisor: 1000 },
  { key: "total-byte-weight", label: "Page weight", unit: "KB", divisor: 1024 },
];

const ms = m.categories.performance.score * 100;
const ds = d.categories.performance.score * 100;

// --- Save raw JSON ---

const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const auditDir = join(import.meta.dir, "../docs/audits");
mkdirSync(auditDir, { recursive: true });

const summary = {
  url,
  timestamp: now.toISOString(),
  mobile: {
    score: ms,
    fcp: metric(m, "first-contentful-paint").numericValue,
    lcp: metric(m, "largest-contentful-paint").numericValue,
    tbt: metric(m, "total-blocking-time").numericValue,
    cls: metric(m, "cumulative-layout-shift").numericValue,
    si: metric(m, "speed-index").numericValue,
    weight: metric(m, "total-byte-weight").numericValue,
  },
  desktop: {
    score: ds,
    fcp: metric(d, "first-contentful-paint").numericValue,
    lcp: metric(d, "largest-contentful-paint").numericValue,
    tbt: metric(d, "total-blocking-time").numericValue,
    cls: metric(d, "cumulative-layout-shift").numericValue,
    si: metric(d, "speed-index").numericValue,
    weight: metric(d, "total-byte-weight").numericValue,
  },
};

const jsonPath = join(auditDir, `perf-audit-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");

// --- Report ---

console.log("");
console.log("  Lighthouse Performance Audit");
console.log("");
console.log("  Metric                   Mobile     Desktop    Budget");
console.log("  ────────────────────────────────────────────────────────");

function fmt(val: number, unit: string, divisor: number): string {
  if (unit === "KB") return Math.round(val / divisor) + " KB";
  if (unit === "ms") return Math.round(val / divisor) + "ms";
  if (unit === "") return (val / divisor).toFixed(3);
  return (val / divisor).toFixed(1) + unit;
}

console.log(
  "  Performance score       "
  + String(ms).padStart(6) + "     "
  + String(ds).padStart(6) + "     >= 90"
);

for (const { key, label, unit, divisor } of metrics) {
  const mv = metric(m, key).numericValue;
  const dv = metric(d, key).numericValue;
  const mStr = fmt(mv, unit, divisor).padStart(unit === "KB" ? 6 : 5);
  const dStr = fmt(dv, unit, divisor).padStart(unit === "KB" ? 6 : 5);

  let budget = "";
  if (key === "first-contentful-paint") budget = "<= 1.8s";
  if (key === "largest-contentful-paint") budget = "<= 2.5s";
  if (key === "total-blocking-time") budget = "<= 200ms";
  if (key === "cumulative-layout-shift") budget = "<= 0.100";
  if (key === "speed-index") budget = "<= 3.4s";

  const padLabel = (label + " ").padEnd(26);
  console.log(`  ${padLabel}${mStr}     ${dStr}     ${budget}`);
}

// --- Budget checks ---

type CheckResult = { label: string; pass: boolean; detail: string };
const results: CheckResult[] = [];

function check(label: string, pass: boolean, detail: string) {
  results.push({ label, pass, detail });
}

check("Mobile score", ms >= 90, `${ms} (want >= 90)`);
check("Desktop score", ds >= 90, `${ds} (want >= 90)`);
check("Mobile FCP", summary.mobile.fcp <= 1800, `${(summary.mobile.fcp / 1000).toFixed(1)}s (want <= 1.8s)`);
check("Desktop FCP", summary.desktop.fcp <= 1800, `${(summary.desktop.fcp / 1000).toFixed(1)}s (want <= 1.8s)`);
check("Mobile LCP", summary.mobile.lcp <= 2500, `${(summary.mobile.lcp / 1000).toFixed(1)}s (want <= 2.5s)`);
check("Desktop LCP", summary.desktop.lcp <= 2500, `${(summary.desktop.lcp / 1000).toFixed(1)}s (want <= 2.5s)`);
check("Mobile TBT", summary.mobile.tbt <= 200, `${Math.round(summary.mobile.tbt)}ms (want <= 200ms)`);
check("Desktop TBT", summary.desktop.tbt <= 200, `${Math.round(summary.desktop.tbt)}ms (want <= 200ms)`);
check("Mobile CLS", summary.mobile.cls <= 0.1, `${summary.mobile.cls.toFixed(3)} (want <= 0.100)`);
check("Desktop CLS", summary.desktop.cls <= 0.1, `${summary.desktop.cls.toFixed(3)} (want <= 0.100)`);

const passCount = results.filter((r) => r.pass).length;
const failCount = results.filter((r) => !r.pass).length;

console.log("");
console.log("  Check                   Result  Detail");
console.log("  ─────────────────────────────────────────────────────────");

for (const r of results) {
  const icon = r.pass ? "PASS" : "FAIL";
  console.log(`  ${r.label.padEnd(24)} ${icon.padEnd(6)} ${r.detail}`);
}

console.log("");
console.log(`  ${passCount} passed, ${failCount} failed`);
console.log(`  Report saved to docs/audits/perf-audit-${stamp}.json`);
console.log("");

// Cleanup temp files
try { require("fs").unlinkSync(tmpMobile); } catch {}
try { require("fs").unlinkSync(tmpDesktop); } catch {}

if (failCount > 0) process.exit(1);
