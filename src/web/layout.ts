// --- Shared layout, nav, and HTML shell ---

export interface NavOpts {
  userName?: string;
  orgName?: string;
  email?: string;
}

export interface SeoOpts {
  title?: string;
  description?: string;
  canonical?: string;
}

export function layout(body: string, title = "Polaris", seo?: SeoOpts): Response {
  const pageTitle = seo?.title ?? title;
  const description = seo?.description ?? "It's like Gong for Claude Code sessions. Capture every prompt, response, and tool call. Stream to Slack. Collaborate in real time.";
  const canonical = seo?.canonical ?? "https://app.withpolaris.ai";
  const ogImage = "https://app.withpolaris.ai/og-image.png";
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${pageTitle}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-gray-50 text-gray-900 antialiased"><div class="overflow-x-hidden max-w-[100vw]">${body}</div>
<script>
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.polaris-copy');
  if (!btn) return;
  const id = btn.dataset.copy;
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent);
  const orig = btn.innerHTML;
  btn.innerHTML = '<svg class="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
  setTimeout(function() { btn.innerHTML = orig; }, 1500);
});
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }
  );
}

export function nav(token?: string, opts?: NavOpts): string {
  const right = token
    ? `<div class="relative group">
         <button class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition">
           <div class="w-7 h-7 rounded-full bg-polaris-600 flex items-center justify-center text-white text-xs font-bold">${(opts?.userName ?? "U").charAt(0).toUpperCase()}</div>
           <div class="text-left">
             <p class="text-xs font-medium text-gray-900 leading-tight">${opts?.userName ?? ""}</p>
             <p class="text-[10px] text-gray-400 leading-tight">${opts?.orgName ?? ""}</p>
           </div>
           <svg class="w-3.5 h-3.5 text-gray-400 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
         </button>
         <div class="hidden group-hover:block absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
           <div class="px-3 py-2 border-b border-gray-100">
             <p class="text-xs font-medium text-gray-900">${opts?.userName ?? ""}</p>
             <p class="text-[10px] text-gray-500">${opts?.email ?? ""}</p>
             <p class="text-[10px] text-gray-400">${opts?.orgName ?? ""}</p>
           </div>
           <a href="/dashboard?token=${token}" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Dashboard</a>
           <a href="/profile?token=${token}" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Profile</a>
           <div class="border-t border-gray-100"></div>
           <a href="/" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Log out</a>
         </div>
       </div>`
    : `<a href="https://github.com/lightup-data/polaris/discussions" class="text-sm font-medium text-gray-500 hover:text-gray-700 hidden sm:inline-flex items-center gap-1.5"><svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Community</a>
       <a href="/login" class="text-sm font-medium text-gray-500 hover:text-gray-700 hidden sm:block">Sign in</a>
       <a href="/signup" class="inline-flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition text-xs sm:text-sm font-medium text-gray-700">
         <svg width="14" height="14" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 3.58z" fill="#EA4335"/></svg>
         Sign up
       </a>`;
  return `
    <nav class="border-b border-gray-200 bg-white">
      <div class="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="${token ? `/dashboard?token=${token}` : "/"}" class="text-lg font-bold tracking-tight text-gray-900">Polaris</a>
        <div class="flex items-center gap-4">${right}</div>
      </div>
    </nav>`;
}

export const slackIcon = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>`;
