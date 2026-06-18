# Lighthouse Baseline — 2026-06-18

Captured before self-hosting Tailwind CSS (currently loaded via CDN).

## Mobile Performance

| Metric                   | Value | Score        |
|--------------------------|-------|--------------|
| **Performance**          | —     | **85/100**   |
| First Contentful Paint   | 3.3s  | 0.39 (poor)  |
| Largest Contentful Paint | 3.3s  | 0.69 (needs work) |
| Total Blocking Time      | 0ms   | 1.0 (perfect) |
| Cumulative Layout Shift  | 0     | 1.0 (perfect) |
| Speed Index              | 3.6s  | 0.87 (good)  |

## Desktop Performance

| Metric                   | Value | Score        |
|--------------------------|-------|--------------|
| **Performance**          | —     | **90/100**   |
| First Contentful Paint   | 1.4s  | 0.61 (needs work) |
| Largest Contentful Paint | 1.4s  | 0.83 (good)  |
| Total Blocking Time      | 0ms   | 1.0 (perfect) |
| Cumulative Layout Shift  | 0     | 1.0 (perfect) |
| Speed Index              | 1.4s  | 0.86 (good)  |

## Page Weight Breakdown

| Resource                      | Size      | % of Total |
|-------------------------------|-----------|------------|
| `cdn.tailwindcss.com/3.4.17`  | 127 KB    | 72%        |
| HTML document                 | 52 KB     | 28%        |
| **Total**                     | **175 KB**| 100%       |

Total network requests: 5

## Key Finding

The Tailwind CDN script (127 KB) is the single largest resource and the
direct cause of the 3.3s FCP — the browser cannot paint until the script
downloads and executes. Switching to purged, self-hosted CSS should reduce
this to ~10 KB of static CSS.
