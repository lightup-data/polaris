// --- One-off pages (landing, welcome, errors) ---

import { nav, slackIcon } from "./layout";
import type { Org } from "../service/db";

export function renderLandingPage(): string {
  return `
    ${nav()}
    <div class="max-w-3xl mx-auto px-6">

      <!-- Hero -->
      <div class="pt-24 pb-16">
        <h1 class="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
          Multiplayer collaboration<br>for Claude Code
        </h1>
        <p class="mt-4 text-lg text-gray-500 max-w-xl">
          Your teammates see what your agent is doing. They can jump in from Slack and steer it in real time.
        </p>
        <div class="mt-8 flex items-center gap-4">
          <a href="#get-started" class="px-5 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition">Get started</a>
          <a href="https://github.com/anthropics/polaris" class="text-sm font-medium text-gray-500 hover:text-gray-700 transition">GitHub</a>
        </div>

        <!-- Terminal demo -->
        <div class="mt-12 bg-gray-900 rounded-xl overflow-hidden shadow-2xl">
          <div class="flex items-center gap-1.5 px-4 py-3 bg-gray-800">
            <div class="w-3 h-3 rounded-full bg-red-500/80"></div>
            <div class="w-3 h-3 rounded-full bg-yellow-500/80"></div>
            <div class="w-3 h-3 rounded-full bg-green-500/80"></div>
            <span class="ml-3 text-xs text-gray-500 font-mono">claude code</span>
          </div>
          <div class="px-5 py-4 font-mono text-sm leading-relaxed space-y-3">
            <div>
              <span class="text-green-400">$</span> <span class="text-gray-300">npm install -g @lightupai/polaris</span>
            </div>
            <div>
              <span class="text-green-400">$</span> <span class="text-gray-300">polaris</span>
            </div>
            <div class="text-gray-500">  Hooks installed. MCP server registered. Logged in as manu@acme.dev</div>
            <div class="border-t border-gray-700 pt-3">
              <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">/polaris join #webapp</span>
            </div>
            <div class="text-gray-500">  Connected to webapp/s-4f2a as user:manu</div>
            <div class="border-t border-gray-700 pt-3">
              <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">implement the auth middleware using RS256</span>
            </div>
            <div class="text-gray-400">  I'll create src/middleware/auth.ts with RS256 JWT verification...</div>
            <div class="mt-1 pl-4 border-l-2 border-yellow-500/50">
              <span class="text-yellow-400 text-xs">priya via slack</span>
              <span class="text-gray-400"> &mdash; make sure to add rate limiting on that endpoint</span>
            </div>
            <div class="text-gray-400">  Good call. Adding rate limiting middleware before deploying...</div>
          </div>
        </div>
      </div>

      <!-- How it works -->
      <div class="py-16 border-t border-gray-200">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">How it works</h2>
        <div class="mt-8 space-y-8">
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">1</div>
            <div>
              <h3 class="font-semibold text-gray-900">Install</h3>
              <p class="mt-1 text-sm text-gray-500"><code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 text-xs">npm install -g @lightupai/polaris && polaris</code> sets up hooks, MCP server, and authenticates your team.</p>
            </div>
          </div>
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">2</div>
            <div>
              <h3 class="font-semibold text-gray-900">Connect</h3>
              <p class="mt-1 text-sm text-gray-500"><code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 text-xs">/polaris join #your-channel</code> links your Claude Code session to your team's Slack channel.</p>
            </div>
          </div>
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">3</div>
            <div>
              <h3 class="font-semibold text-gray-900">Collaborate</h3>
              <p class="mt-1 text-sm text-gray-500">Every prompt and response streams to Slack. Teammates reply there and their messages appear inline in your agent session.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Why Polaris -->
      <div class="py-16 border-t border-gray-200">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">Why Polaris</h2>
        <div class="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="border border-gray-200 rounded-lg p-5">
            <h3 class="font-semibold text-gray-900">No context switching</h3>
            <p class="mt-2 text-sm text-gray-500">Teammate messages arrive directly in your coding session. No tab switching, no copy-pasting, no "hey can you check Slack."</p>
          </div>
          <div class="border border-gray-200 rounded-lg p-5">
            <h3 class="font-semibold text-gray-900">Full session visibility</h3>
            <p class="mt-2 text-sm text-gray-500">Every prompt, tool call, and response is captured and streamed to your team. Anyone can see what's happening and jump in.</p>
          </div>
          <div class="border border-gray-200 rounded-lg p-5">
            <h3 class="font-semibold text-gray-900">Human + AI multiplayer</h3>
            <p class="mt-2 text-sm text-gray-500">Multiple developers, multiple agents, concurrent sessions. Humans and AI are first-class participants on the same floor.</p>
          </div>
          <div class="border border-gray-200 rounded-lg p-5">
            <h3 class="font-semibold text-gray-900">Two-minute setup</h3>
            <p class="mt-2 text-sm text-gray-500">One npm install, one command. No config files, no Docker, no infrastructure. Works with your existing Slack workspace.</p>
          </div>
        </div>
      </div>

      <!-- Slack demo -->
      <div class="py-16 border-t border-gray-200">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">What your team sees in Slack</h2>
        <div class="mt-8 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <div class="flex">
            <div class="w-14 bg-[#4A154B] shrink-0 flex flex-col items-center py-3 gap-3">
              <div class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center text-white text-xs font-bold">A</div>
              <div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
              </div>
            </div>
            <div class="flex-1">
              <div class="border-b border-gray-200 px-4 py-2.5 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="text-gray-900 font-bold text-sm"># webapp</span>
                  <span class="text-gray-400 text-xs">|</span>
                  <span class="text-gray-400 text-xs">2 drivers, 1 advisor</span>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex -space-x-1.5">
                    <div class="w-5 h-5 rounded-full bg-blue-500 border-2 border-white"></div>
                    <div class="w-5 h-5 rounded-full bg-yellow-500 border-2 border-white"></div>
                    <div class="w-5 h-5 rounded-full bg-purple-600 border-2 border-white"></div>
                  </div>
                  <span class="text-gray-400 text-xs">3</span>
                </div>
              </div>
              <div class="px-5 py-4 space-y-4 text-sm">
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">M</div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">Manu</span><span class="text-gray-400 text-xs">auth</span><span class="text-gray-400 text-xs">10:31 AM</span></div>
                    <p class="text-gray-700">Let's implement the auth middleware</p>
                  </div>
                </div>
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-green-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">AI</div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">Agent</span><span class="text-gray-400 text-xs">&rarr; manu/auth</span><span class="text-gray-400 text-xs">10:31 AM</span></div>
                    <p class="text-gray-700">I'll create <code class="bg-gray-100 px-1 rounded text-red-600 text-xs">src/middleware/auth.ts</code> with JWT verification...</p>
                  </div>
                </div>
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-yellow-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">P</div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">Priya</span><span class="text-gray-400 text-xs">&rarr; auth</span><span class="text-gray-400 text-xs">10:33 AM</span></div>
                    <p class="text-gray-700">Use RS256, not HS256 — we need asymmetric keys for the microservices</p>
                  </div>
                </div>
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-green-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">AI</div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">Agent</span><span class="text-gray-400 text-xs">&rarr; manu/auth</span><span class="text-gray-400 text-xs">10:33 AM</span></div>
                    <p class="text-gray-700">Good point from Priya. Switching to RS256 and updating the key config...</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Get Started -->
      <div id="get-started" class="py-16 border-t border-gray-200">
        <h2 class="text-2xl font-bold text-gray-900">Get started</h2>
        <div class="mt-6 bg-gray-900 rounded-xl overflow-hidden">
          <div class="flex items-center justify-between px-4 py-2.5 bg-gray-800">
            <span class="text-xs text-gray-500 font-mono">terminal</span>
            <button class="polaris-copy text-gray-500 hover:text-gray-300 transition" data-copy="install-cmd">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            </button>
          </div>
          <pre class="px-5 py-4 font-mono text-sm text-gray-300 leading-relaxed" id="install-cmd"><span class="text-green-400">$</span> npm install -g @lightupai/polaris
<span class="text-green-400">$</span> polaris</pre>
        </div>
        <p class="mt-4 text-sm text-gray-500">Then in Claude Code:</p>
        <div class="mt-2 bg-gray-900 rounded-xl overflow-hidden">
          <pre class="px-5 py-4 font-mono text-sm text-gray-300 leading-relaxed"><span class="text-polaris-400">&gt;</span> /polaris join #your-channel</pre>
        </div>
        <p class="mt-6 text-sm text-gray-500">That's it. Your session is now live to your team.</p>
        <div class="mt-8">
          <a href="/signup" class="inline-flex items-center gap-3 px-5 py-2.5 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition text-sm font-medium text-gray-700">
            <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 3.58z" fill="#EA4335"/></svg>
            Sign up with Google
          </a>
        </div>
      </div>
    </div>

    <footer class="border-t border-gray-200 mt-8">
      <div class="max-w-3xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-gray-400">
        <span>Polaris</span>
        <div class="flex items-center gap-6">
          <a href="https://github.com/anthropics/polaris" class="hover:text-gray-600 transition">GitHub</a>
          <a href="/login" class="hover:text-gray-600 transition">Sign in</a>
        </div>
      </div>
    </footer>`;
}

export function renderWelcomePage(token: string, name: string, orgName: string, org: Org): string {
  return `
    ${nav(token, { userName: name, orgName, email: "" })}
    <div class="max-w-lg mx-auto px-6 pt-24">
      <div class="text-center">
        <div class="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        </div>
        <h1 class="text-2xl font-bold text-gray-900">Welcome to Polaris</h1>
        <p class="mt-2 text-gray-600">${orgName} is ready to go.</p>
      </div>
      <div class="mt-8">
        <a href="/dashboard?token=${token}" class="block w-full text-center px-6 py-3 bg-polaris-700 text-white text-sm font-semibold rounded-lg hover:bg-polaris-800 transition">Go to dashboard</a>
      </div>
    </div>`;
}
