/**
 * DataForSEO on-page SEO audit.
 *
 * Usage:
 *   DATAFORSEO_AUTH=<base64> bun run scripts/seo-audit.ts [url]
 *
 * Reads credentials from DATAFORSEO_AUTH env var, or falls back to
 * ~/workspace/mbhome/keys/lightup-dataforseo-api-key-manub.
 *
 * Prints a formatted report and saves raw JSON to docs/audits/.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const url = process.argv[2] ?? "https://app.withpolaris.ai";

// --- Credentials ---

function getAuth(): string {
  if (process.env.DATAFORSEO_AUTH) return process.env.DATAFORSEO_AUTH;
  const keyFile = join(homedir(), "workspace/mbhome/keys/lightup-dataforseo-api-key-manub");
  try {
    const content = readFileSync(keyFile, "utf-8");
    const match = content.match(/api password base64:\s*(.+)/);
    if (match) return match[1].trim();
  } catch {}
  console.error("Error: Set DATAFORSEO_AUTH or ensure key file exists at ~/workspace/mbhome/keys/lightup-dataforseo-api-key-manub");
  process.exit(1);
}

const auth = getAuth();

// --- API call ---

const res = await fetch("https://api.dataforseo.com/v3/on_page/instant_pages", {
  method: "POST",
  headers: {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify([{ url, enable_javascript: true }]),
});

if (!res.ok) {
  console.error(`API error: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const data = await res.json();
const task = data.tasks?.[0];

if (!task || task.status_code !== 20000) {
  console.error("API returned an error:", task?.status_message ?? "unknown");
  process.exit(1);
}

const page = task.result?.[0]?.items?.[0];
if (!page) {
  console.error("No page data returned");
  process.exit(1);
}

// --- Save raw JSON ---

const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const auditDir = join(import.meta.dir, "../docs/audits");
mkdirSync(auditDir, { recursive: true });
const jsonPath = join(auditDir, `seo-audit-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(page, null, 2) + "\n");

// --- Report ---

const meta = page.meta ?? {};
const checks = page.checks ?? {};
const timing = page.page_timing ?? {};
const content = meta.content ?? {};
const social = meta.social_media_tags ?? {};
const htags = meta.htags ?? {};

type CheckResult = { label: string; pass: boolean; detail: string };
const results: CheckResult[] = [];

function check(label: string, pass: boolean, detail: string) {
  results.push({ label, pass, detail });
}

// Meta
check("Title", !!meta.title && meta.title_length >= 30 && meta.title_length <= 60,
  meta.title ? `${meta.title_length} chars` : "missing");
check("Description", !!meta.description && meta.description_length >= 70 && meta.description_length <= 160,
  meta.description ? `${meta.description_length} chars` : "missing");
check("Canonical", !!meta.canonical, meta.canonical ?? "missing");
check("HTTPS", !!checks.is_https, checks.is_https ? "yes" : "no");
check("Doctype", !!checks.has_html_doctype, checks.has_html_doctype ? "yes" : "no");
check("Charset", !!checks.meta_charset_consistency, checks.meta_charset_consistency ? "consistent" : "inconsistent");

// Headings
const h1Count = htags.h1?.length ?? 0;
check("Single H1", h1Count === 1, `${h1Count} h1 tag(s)`);
check("Heading hierarchy", (htags.h2?.length ?? 0) > 0, `h1:${h1Count} h2:${htags.h2?.length ?? 0} h3:${htags.h3?.length ?? 0}`);

// Social
check("OG tags", !!social["og:title"] && !!social["og:description"] && !!social["og:image"],
  social["og:title"] ? "title + desc + image" : "incomplete");
check("Twitter card", !!social["twitter:card"],
  social["twitter:card"] ?? "missing");

// Content
check("Content rate", !checks.low_content_rate,
  `${(content.plain_text_rate * 100).toFixed(1)}% (want >= 10%)`);
check("Title/content match", content.title_to_content_consistency >= 0.8,
  content.title_to_content_consistency?.toFixed(2) ?? "n/a");
check("Desc/content match", content.description_to_content_consistency >= 0.8,
  content.description_to_content_consistency?.toFixed(2) ?? "n/a");

// Technical
check("Favicon", !checks.no_favicon, checks.no_favicon ? "missing" : "present");
check("No render-blocking scripts", (meta.render_blocking_scripts_count ?? 0) === 0,
  (meta.render_blocking_scripts_count ?? 0) === 0 ? "clean" : `${meta.render_blocking_scripts_count} script(s)`);
check("Content encoding", !checks.no_content_encoding,
  checks.no_content_encoding ? "no gzip/brotli" : "enabled");
check("SEO-friendly URL", !!checks.seo_friendly_url, checks.seo_friendly_url ? "yes" : "no");
check("Image alt text", !checks.no_image_alt, checks.no_image_alt ? "missing on some images" : "present");
check("No broken links", !checks.is_broken, checks.is_broken ? "broken" : "ok");
check("Page size", !checks.large_page_size, checks.large_page_size ? ">3MB" : `${Math.round(page.encoded_size / 1024)} KB`);

// Print report
console.log("");
console.log(`  DataForSEO On-Page Audit — ${url}`);
console.log(`  On-Page Score: ${page.onpage_score}/100`);
console.log(`  Page size: ${Math.round(page.encoded_size / 1024)} KB (${Math.round(page.total_dom_size / 1024)} KB DOM)`);
console.log(`  Words: ${content.plain_text_word_count}  Readability: ${content.flesch_kincaid_readability_index?.toFixed(0)}/100 Flesch-Kincaid`);
console.log("");
console.log("  Check                   Result  Detail");
console.log("  ─────────────────────────────────────────────────────────");

const passCount = results.filter((r) => r.pass).length;
const failCount = results.filter((r) => !r.pass).length;

for (const r of results) {
  const icon = r.pass ? "PASS" : "FAIL";
  console.log(`  ${r.label.padEnd(24)} ${icon.padEnd(6)} ${r.detail}`);
}

console.log("");
console.log(`  ${passCount} passed, ${failCount} failed`);
console.log(`  Report saved to docs/audits/seo-audit-${stamp}.json`);
console.log("");

// Exit non-zero if any checks failed
if (failCount > 0) process.exit(1);
