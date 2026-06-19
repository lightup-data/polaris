# SEO & Geo — Tracker

## Completed

- [x] **Meta tags** — title, description on every page via `SeoOpts` in layout
- [x] **Open Graph tags** — og:title, og:description, og:image, og:url for rich link previews on Slack/Twitter/LinkedIn
- [x] **Twitter cards** — summary_large_image format with title, description, image
- [x] **OG image** — 1200x630 PNG of hero section served at `/og-image.png` with 24h cache
- [x] **Canonical URL** — set to `https://app.withpolaris.ai`
- [x] **robots.txt** — allows all crawlers, points to sitemap
- [x] **sitemap.xml** — lists the landing page
- [x] **Cloudflare DNS** — domain managed on Cloudflare with MX + SPF records
- [x] **Email routing** — `*@withpolaris.ai` forwards to `support@lightup.ai`
- [x] **Self-host Tailwind CSS** — replaced 127KB CDN script with purged 26KB static CSS (5.5KB gzip). Production Lighthouse: score 84→99, FCP 3.4s→1.6s, page weight 175KB→77KB
- [x] **Lighthouse performance audit** — `make perf` runs mobile+desktop against prod and local, checks Google "good" budgets (score≥90, FCP≤1.8s, LCP≤2.5s), saves JSON to `docs/audits/`
- [x] **DataForSEO on-page audit** — `make seo` runs 20 SEO checks via DataForSEO API, saves JSON to `docs/audits/`
- [x] **Heading hierarchy** — verified: 1×h1, 7×h2, 18×h3, proper structure (DataForSEO score 100/100)
- [x] **Favicon** — SVG favicon (polaris-600 hub icon) with immutable cache, favicon.ico redirects to it
- [x] **gzip/zstd compression** — enabled in Caddy, page size over the wire: 51KB→9KB
- [x] **Schema markup (JSON-LD)** — SoftwareApplication structured data with pricing, category, platform, and organization
- [x] **Google Analytics** — GA4 property G-N00X6NR17E, async gtag.js in layout
- [x] **404 page** — custom error page with navigation back to home
- [x] **Page titles** — dashboard ("Dashboard — Polaris"), setup ("Setup — Polaris"), profile ("Polaris - Profile")
- [x] **Alt text on images** — added to all img tags on the landing page

- [x] **Google Search Console** — property verified via DNS TXT record, sitemap submitted

## SEO — To Do

- [ ] **Blog / content marketing**
  Long-tail SEO needs content pages targeting search terms:
  - "How to collaborate on Claude Code sessions"
  - "AI session capture for engineering teams"
  - "Multiplayer AI coding with Slack"
  - "AI agent observability for developers"
  - "Gong for AI coding"
  Options: simple `/blog` route with markdown rendering, or a subdomain `blog.withpolaris.ai`.

## GEO — To Do

Generative Engine Optimization — getting Polaris cited by LLMs (ChatGPT,
Perplexity, Gemini, Claude) when users ask about AI coding session tools.

**Baseline (2026-06-18):** Polaris is mentioned by 0/3 major LLMs for
"Gong for AI coding" queries. Competitors cited: AgentReplay, vibe-replay,
Longhouse, SessionForge, CC Replay, Blackcrab, Mantra, Nokos.

### High Priority

- [x] **GitHub README as the canonical source** — rewrote intro to lead with "Gong for Claude Code sessions", added "What Polaris does" section matching LLM fan-out queries
- [x] **npm package description** — added description, 10 keywords, homepage, and repo URL to package.json

- [ ] **Comparison matrix into landing page and blog**
  Draft in `docs/comparison-matrix.html`. Needs review on positioning,
  competitor accuracy, and feature claims before publishing. Use as
  a landing page section and as the basis for a comparison blog post.

- [ ] **Comparison / "alternatives" blog post**
  LLMs heavily cite comparison pages. Write a post like "Polaris vs
  AgentReplay vs SessionForge — AI coding session tools compared"
  that positions Polaris and links to withpolaris.ai. Publish on the
  blog and cross-post to dev.to / Medium.

- [ ] **Reddit / Hacker News / community presence**
  LLMs cite Reddit and HN threads. Post in:
  - r/ClaudeAI (GPT-5.5 already cites a Claude Code replay post there)
  - r/ChatGPTPro, r/LocalLLaMA, r/ExperiencedDevs
  - Hacker News Show HN
  Include link to withpolaris.ai in posts/comments.

### Medium Priority

- [ ] **Landing page copy matches LLM fan-out queries**
  GPT-5.5 searches for: "Claude Code session recording sharing tools",
  "AI coding session recording tool Claude Code terminal replay",
  "Claude Code observability session recordings tool". Ensure the
  landing page H1/H2/description contain these phrases naturally.

- [ ] **Dev blog with target keyword articles**
  Write content targeting the exact queries LLMs use:
  - "How to record Claude Code sessions"
  - "AI coding session recording for teams"
  - "Multiplayer AI coding with Slack"
  Options: `/blog` route with markdown, or subdomain `blog.withpolaris.ai`.

- [ ] **GitHub Discussions / Issues as citable content**
  LLMs scrape GitHub discussions. Active Q&A in Discussions creates
  citable pages linking back to Polaris. Seed with FAQs and how-tos.

- [ ] **Product Hunt launch**
  Creates a high-authority page that LLMs cite. Time it with a
  feature milestone.

### Low Priority

- [ ] **Structured data for LLM parsing**
  Add `llms.txt` or `llms-full.txt` to the site root — an emerging
  convention for telling LLMs about your product in a machine-friendly
  format. See llmstxt.org.

- [ ] **Monitor GEO position over time**
  Set up periodic DataForSEO `ai_optimization_llm_response` queries
  for target keywords across ChatGPT/Perplexity/Gemini. Track whether
  Polaris starts appearing in responses. Requires DFS subscription
  for `ai_opt_llm_ment_search`.

## GEO — Competitors

Tools cited by LLMs for "Gong for AI coding" (as of 2026-06-18):

| Tool | Cited by | Positioning |
|---|---|---|
| AgentReplay | ChatGPT | "Loom for your AI coding agent" |
| vibe-replay | ChatGPT | Analytics + replay across tools |
| Longhouse | ChatGPT | Mission control for AI coding sessions |
| SessionForge | ChatGPT | Team visibility / RBAC / remote sessions |
| CC Replay | ChatGPT | Claude Code-specific local replay |
| Blackcrab | ChatGPT | Claude Code GUI |
| Multiplayer.app | Perplexity | AI dev workflow capture |
| Mantra | Gemini | Unified AI session manager |
| Nokos | Gemini | Cross-tool conversation capture |
| claude-devtools | Gemini | JSONL transcript viewer |

## Target Keywords

Primary (match LLM fan-out queries):
- "AI coding session recording"
- "Claude Code session recording"
- "Gong for AI coding"
- "Claude Code collaboration"
- "AI coding session tools"

Secondary:
- "AI session capture tool"
- "multiplayer AI coding"
- "Slack integration for AI coding"
- "AI agent observability"
- "engineering knowledge capture AI"

## Useful Links

- Google Search Console: https://search.google.com/search-console
- Google Analytics: https://analytics.google.com (property 542281886)
- OG image tester: https://www.opengraph.xyz/
- Twitter card validator: https://cards-dev.twitter.com/validator
- PageSpeed Insights: https://pagespeed.web.dev/
- Cloudflare dashboard: https://dash.cloudflare.com/
- DataForSEO: https://app.dataforseo.com/
