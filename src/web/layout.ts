// --- Shared layout, nav, and HTML shell ---

export interface NavOpts {
  userName?: string;
  orgName?: string;
  email?: string;
}

export function layout(body: string, title = "Polaris"): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        polaris: { 50: '#f0f4ff', 100: '#dbe4ff', 200: '#bac8ff', 300: '#91a7ff', 400: '#748ffc', 500: '#5c7cfa', 600: '#4c6ef5', 700: '#4263eb', 800: '#3b5bdb', 900: '#364fc7' }
      }
    }
  }
}
</script>
</head>
<body class="bg-gray-50 text-gray-900 antialiased">${body}
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
    ? `<a href="/search?token=${token}" class="text-sm font-medium text-gray-600 hover:text-gray-900">Search</a>
       <div class="relative group">
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
           <a href="/search?token=${token}" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Search</a>
           <a href="/profile?token=${token}" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Profile</a>
           <div class="border-t border-gray-100"></div>
           <a href="/" class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Log out</a>
         </div>
       </div>`
    : `<a href="/login" class="text-sm font-medium text-polaris-700 hover:text-polaris-800">Sign in</a>`;
  return `
    <nav class="border-b border-gray-200 bg-white">
      <div class="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="${token ? `/dashboard?token=${token}` : "/"}" class="text-lg font-bold tracking-tight text-gray-900">Polaris</a>
        <div class="flex items-center gap-4">${right}</div>
      </div>
    </nav>`;
}

export const slackIcon = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>`;
