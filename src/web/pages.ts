// --- One-off pages (landing, welcome, errors) ---

import { nav, slackIcon } from "./layout";
import type { Org } from "../service/db";

export function renderLandingPage(): string {
  return `
    ${nav()}
    <div class="max-w-5xl mx-auto px-6">
      <div class="pt-24 pb-16 text-center">
        <h1 class="text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl">
          Multiplayer AI collaboration
        </h1>
        <p class="mt-6 text-lg leading-8 text-gray-600 max-w-2xl mx-auto">
          Polaris connects your AI agent sessions to your team. Capture every interaction, pool context across workstreams, and let anyone contribute — all in real time.
        </p>
        <div class="mt-10 flex flex-col items-center gap-4">
          <a href="/signup" class="inline-flex items-center gap-3 px-6 py-3 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition text-sm font-semibold text-gray-700">
            <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 2.58 9 3.58z" fill="#EA4335"/></svg>
            Sign up with Google
          </a>
          <a href="/login" class="px-6 py-3 text-sm font-semibold text-gray-500 hover:text-gray-700 transition">Already have an account? Sign in</a>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-8 py-16 border-t border-gray-200">
        <div>
          <div class="w-10 h-10 rounded-lg bg-polaris-100 flex items-center justify-center mb-4">
            <svg class="w-5 h-5 text-polaris-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 6.523 5 10 5c3.477 0 6.268 2.943 7.542 7-.274.985-.633 1.928-1.065 2.813M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          </div>
          <h3 class="text-sm font-semibold text-gray-900">Session capture</h3>
          <p class="mt-2 text-sm text-gray-600">Every prompt, response, and tool call is captured and broadcast to your team's floor.</p>
        </div>
        <div>
          <div class="w-10 h-10 rounded-lg bg-polaris-100 flex items-center justify-center mb-4">
            <svg class="w-5 h-5 text-polaris-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"/></svg>
          </div>
          <h3 class="text-sm font-semibold text-gray-900">Context injection</h3>
          <p class="mt-2 text-sm text-gray-600">Teammates inject expertise directly into your agent session from Slack, WhatsApp, or any floor.</p>
        </div>
        <div>
          <div class="w-10 h-10 rounded-lg bg-polaris-100 flex items-center justify-center mb-4">
            <svg class="w-5 h-5 text-polaris-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m3 5.197V21"/></svg>
          </div>
          <h3 class="text-sm font-semibold text-gray-900">Multiplayer</h3>
          <p class="mt-2 text-sm text-gray-600">Multiple drivers, concurrent sessions, seamless handoffs. Humans and AI agents as first-class participants.</p>
        </div>
      </div>

      <div class="py-16 border-t border-gray-200">
        <h2 class="text-2xl font-bold text-gray-900 text-center">How it works</h2>
        <p class="mt-2 text-center text-sm text-gray-500">Everything streams to the floor — your team's Slack channel.</p>

        <div class="mt-8 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <div class="flex">
            <div class="w-14 bg-[#4A154B] shrink-0 flex flex-col items-center py-3 gap-3">
              <div class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center text-white text-xs font-bold">A</div>
              <div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
              </div>
              <div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
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
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">
                    <svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                  </div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">security-bot</span><span class="bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded">agent</span><span class="text-gray-400 text-xs">&rarr; auth</span><span class="text-gray-400 text-xs">10:34 AM</span></div>
                    <p class="text-gray-700">This auth endpoint needs rate limiting before going to production</p>
                  </div>
                </div>
                <div class="flex gap-3">
                  <div class="w-8 h-8 rounded-md bg-green-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">AI</div>
                  <div>
                    <div class="flex items-baseline gap-2"><span class="text-gray-900 font-bold text-sm">Agent</span><span class="text-gray-400 text-xs">&rarr; manu/auth</span><span class="text-gray-400 text-xs">10:34 AM</span></div>
                    <p class="text-gray-700">Adding rate limiting middleware to the auth endpoints...</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p class="mt-4 text-center text-sm text-gray-500">The floor — a continuous, attributed log of how your work gets built.</p>
      </div>
    </div>

    <footer class="border-t border-gray-200 mt-16">
      <div class="max-w-5xl mx-auto px-6 py-8 text-center text-sm text-gray-500">
        Polaris by Lightup
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
