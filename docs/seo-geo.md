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

## SEO — To Do

### High Priority

- [ ] **Submit sitemap to Google Search Console**
  Register `app.withpolaris.ai` at https://search.google.com/search-console.
  Verify ownership via Cloudflare DNS TXT record. Submit sitemap URL.

- [ ] **Add analytics**
  No traffic data currently. Options:
  - Plausible (privacy-friendly, lightweight, ~$9/mo)
  - Google Analytics (free, full-featured, heavier)
  - Cloudflare Web Analytics (free, built into Cloudflare dashboard)
  Add the tracking script to the layout.

- [ ] **Self-host Tailwind CSS**
  Currently loading Tailwind CDN (~300KB) on every page. Purge and self-host
  to reduce to ~10KB. Improves page speed and Core Web Vitals score.
  Affects Google ranking.

### Medium Priority

- [ ] **Schema markup (JSON-LD)**
  Add structured data for SoftwareApplication and Organization.
  Helps Google show rich results (product name, pricing, etc.).
  ```json
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Polaris",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "macOS, Linux",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    }
  }
  ```

- [ ] **Blog / content marketing**
  Long-tail SEO needs content pages targeting search terms:
  - "How to collaborate on Claude Code sessions"
  - "AI session capture for engineering teams"
  - "Multiplayer AI coding with Slack"
  - "AI agent observability for developers"
  - "Gong for AI coding"
  Options: simple `/blog` route with markdown rendering, or a subdomain `blog.withpolaris.ai`.

- [ ] **Heading hierarchy audit**
  Ensure proper h1 → h2 → h3 structure on the landing page.
  Only one h1 per page. Check that section headers use correct levels.

### Low Priority

- [ ] **Favicon**
  No favicon set. Add one for browser tabs and bookmarks.
  Use the Polaris hub icon or a simplified version.

- [ ] **404 page**
  Custom 404 page with navigation back to the landing page.
  Currently returns a default error.

- [ ] **Page title for dashboard pages**
  Dashboard, profile, and other authenticated pages should have
  descriptive titles (e.g., "Dashboard — Polaris") instead of just "Polaris".

- [ ] **Alt text on images**
  The Claude Code PNG icon and any other images need alt text for
  accessibility and SEO.

## Geo — To Do

### High Priority

- [ ] **Enable Cloudflare proxy (orange cloud)**
  DNS records for `app.withpolaris.ai` and `api.withpolaris.ai` are
  likely DNS-only (gray cloud). Switching to proxied gives:
  - Free global CDN (faster loads worldwide)
  - Automatic caching of static assets
  - DDoS protection
  - Web Application Firewall
  Note: Caddy handles HTTPS on the server. Enabling Cloudflare proxy
  means Cloudflare terminates TLS and connects to Caddy. Need to set
  Cloudflare SSL mode to "Full (strict)" and ensure Caddy's certs
  are valid. Test carefully.

### Medium Priority

- [ ] **Check server location**
  Verify where the Hetzner VPS is located (likely EU — Finland or Germany).
  If most users are US-based, consider:
  - Migrating to a US Hetzner datacenter (Ashburn, VA)
  - Or relying on Cloudflare proxy to cache static content at edge

- [ ] **Cache headers for static assets**
  OG image has 24h cache. Landing page HTML has `Cache-Control: no-store`.
  Consider adding short cache (5-10 min) for the landing page since it
  changes infrequently. CSS/JS should have long cache with versioned URLs.

### Low Priority

- [ ] **Content localization**
  Not needed yet. English only. Revisit if expanding to non-English markets.

- [ ] **CDN for the npm package**
  The CLI is published to npm. npm CDN (unpkg, jsdelivr) handles global
  distribution automatically. No action needed.

## Target Keywords

Primary:
- "AI coding session recording"
- "Claude Code collaboration"
- "AI agent observability"
- "Slack integration for AI coding"
- "Gong for AI coding"

Secondary:
- "AI session capture tool"
- "multiplayer AI coding"
- "AI coding agent memory"
- "context graph for AI agents"
- "engineering knowledge capture AI"

## Useful Links

- Google Search Console: https://search.google.com/search-console
- OG image tester: https://www.opengraph.xyz/
- Twitter card validator: https://cards-dev.twitter.com/validator
- PageSpeed Insights: https://pagespeed.web.dev/
- Cloudflare dashboard: https://dash.cloudflare.com/
