// --- One-off pages (landing, welcome, errors) ---

import { nav, slackIcon } from "./layout";
import type { Org } from "../service/db";

export function renderLandingPage(): string {
  return `
    ${nav()}
    <!-- Hero: text left, hub diagram right -->
    <div class="max-w-6xl mx-auto px-6 pt-24 pb-16">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">

        <!-- Left: text -->
        <div>
          <h1 class="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Meet Polaris.<br>It's like Gong for Claude Code sessions.
          </h1>
          <p class="mt-6 text-lg text-gray-500">
            Bring your local Claude Code sessions straight into a collaborative Slack channel. Polaris works in the background to automatically capture and document the AI's entire execution path including all prompts, responses, and tool calls in real time. Teammates can watch the live log stream, intervene with inline commands via Slack, or audit the complete thought process later.
          </p>
        </div>

        <!-- Right: hub diagram -->
        <div class="flex flex-col items-center">

          <!-- Slack node -->
          <div class="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-lg shadow-sm">
            <svg class="w-4 h-4 text-[#4A154B]" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>
            <span class="text-sm font-semibold text-gray-900"># webapp</span>
          </div>

          <!-- Arrow: Slack ↔ Polaris -->
          <svg class="w-5 h-14 text-gray-300" viewBox="0 0 20 56" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M7 4 L7 52 M4 7 L7 4 L10 7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M13 52 L13 4 M10 49 L13 52 L16 49" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>

          <!-- Polaris hub -->
          <div class="w-20 h-20 rounded-full bg-polaris-700 shadow-lg flex flex-col items-center justify-center">
            <svg class="w-6 h-6 text-white" viewBox="0 0 20 20" fill="currentColor">
              <circle cx="10" cy="10" r="2.5"/>
              <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.2"/>
              <line x1="10" y1="1" x2="10" y2="5" stroke="currentColor" stroke-width="1.2"/>
              <line x1="10" y1="15" x2="10" y2="19" stroke="currentColor" stroke-width="1.2"/>
              <line x1="1" y1="10" x2="5" y2="10" stroke="currentColor" stroke-width="1.2"/>
              <line x1="15" y1="10" x2="19" y2="10" stroke="currentColor" stroke-width="1.2"/>
            </svg>
            <span class="text-white text-[10px] font-bold mt-0.5">Polaris</span>
          </div>

          <!-- Branching arrows: Polaris ↔ sessions -->
          <svg class="w-80 h-16 text-gray-300" viewBox="0 0 320 64" fill="none" stroke="currentColor" stroke-width="1.5" overflow="visible">
            <path d="M160 0 L160 20" stroke-linecap="round"/>
            <path d="M157 20 L160 0 L163 20" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M160 20 L48 58" stroke-linecap="round"/>
            <path d="M52 46 L48 58 L60 54" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M160 20 L160 104" stroke-linecap="round"/>
            <path d="M157 101 L160 104 L163 101" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M160 20 L272 58" stroke-linecap="round"/>
            <path d="M260 54 L272 58 L268 46" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>

          <!-- Session nodes -->
          <div class="flex items-start gap-6">
            <div class="flex items-center gap-2 px-4 py-2.5 bg-gray-900 rounded-lg shadow-sm">
              <img class="w-5 h-5" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAMAAAA7EzkRAAAAFVBMVEVMaXHZd1fZd1babUjZd1faf1rZd1epRaWRAAAABnRSTlMAXawH8g5t5RLrAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFOklEQVR42u3WUQ6EIAxAQcDV+x95r1Bjk2Kdid81wkMdAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADebtHa9gFedPYTIAIUoAAFiAAFKEABIkABClCACFCAAhQgAkSAAkSACFCACBABChABIkABIkAEKEAEiAAFiAARoAARIAIUIAJEgAJEgAhQgAgQAQoQASJAAQpQgAhQgAIUIAIUoAAFiAAFKEABIkABClCACBABChABIkABIkAEKEAEiAAFiAARoAARIAIUIAJEgAJEgAhQgAgQAQoQASJAASJABChABIgABShAASJAAQpQgAhQgAIUIAIUoAAFiAARoAARIAIUIAJEgAJEgAhQgAjwnjNmfq2EGVwYAT4UvO33AqzZDwEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoACTHTHfCzC4MNkBHsnGBYUEiAARIAgQAYIAESAIEAGCABEgCBABggARIAgQAYIAESAIEAGCABEgCBABggARIAgQAYIAESAIEAEiQBAgAgQBIkAQIAIEASJAECACBAEiQBAgAgQBIkAQIAIEASJAECACBAEiQBAgAgQBIkAQIAIEASJABAgCRIAgQAQIAkSAIEAECAJEgCBABAgCRIDwNMCVzJL2lt3LyGaLmr+xdmeLBChABIgABYgAEaAAESACFCACRIACRIAIUIAIEAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAhSgABGgAAUoQAQoQAEKEAEKUIACRIAIUIAIEAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAkSACFCACBABChABIkABIkAEKEABChABClCAAkSAAhSgABGgAAUoQAQoQAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAkSACDDJjFnRBy6aVyb6HKto3mhiJp+4W/OOXa8bX5CZ/EVqU9YbAuzwCyNAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKcEvnDCqaV3cyg86ieQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwJv8Af3P8SOrUE9bAAAAAElFTkSuQmCC"/>
              <span class="text-xs text-gray-300">Alice working on auth</span>
            </div>
            <div class="flex items-center gap-2 px-4 py-2.5 mt-10 bg-white border border-gray-200 rounded-lg shadow-sm">
              <svg class="w-4 h-4 text-blue-500" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C8 4.4 4.4 8 0 8c4.4 0 8 3.6 8 8 0-4.4 3.6-8 8-8-4.4 0-8-3.6-8-8z"/></svg>
              <span class="text-xs text-gray-700">Martha writing docs</span>
            </div>
            <div class="flex items-center gap-2 px-4 py-2.5 bg-gray-900 rounded-lg shadow-sm">
              <img class="w-5 h-5" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAMAAAA7EzkRAAAAFVBMVEVMaXHZd1fZd1babUjZd1faf1rZd1epRaWRAAAABnRSTlMAXawH8g5t5RLrAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFOklEQVR42u3WUQ6EIAxAQcDV+x95r1Bjk2Kdid81wkMdAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADebtHa9gFedPYTIAIUoAAFiAAFKEABIkABClCACFCAAhQgAkSAAkSACFCACBABChABIkABIkAEKEAEiAAFiAARoAARIAIUIAJEgAJEgAhQgAgQAQoQASJAAQpQgAhQgAIUIAIUoAAFiAAFKEABIkABClCACBABChABIkABIkAEKEAEiAAFiAARoAARIAIUIAJEgAJEgAhQgAgQAQoQASJAASJABChABIgABShAASJAAQpQgAhQgAIUIAIUoAAFiAARoAARIAIUIAJEgAJEgAhQgAjwnjNmfq2EGVwYAT4UvO33AqzZDwEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoACTHTHfCzC4MNkBHsnGBYUEiAARIAgQAYIAESAIEAGCABEgCBABggARIAgQAYIAESAIEAGCABEgCBABggARIAgQAYIAESAIEAEiQBAgAgQBIkAQIAIEASJAECACBAEiQBAgAgQBIkAQIAIEASJAECACBAEiQBAgAgQBIkAQIAIEASJABAgCRIAgQAQIAkSAIEAECAJEgCBABAgCRIDwNMCVzJL2lt3LyGaLmr+xdmeLBChABIgABYgAEaAAESACFCACRIACRIAIUIAIEAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAhSgABGgAAUoQAQoQAEKEAEKUIACRIAIUIAIEAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAkSACFCACBABChABIkABIkAEKEABChABClCAAkSAAhSgABGgAAUoQAQoQAEKEAEiQAEiQAQoQASIAAWIABGgABEgAhQgAkSAAkSACDDJjFnRBy6aVyb6HKto3mhiJp+4W/OOXa8bX5CZ/EVqU9YbAuzwCyNAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKcEvnDCqaV3cyg86ieQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwJv8Af3P8SOrUE9bAAAAAElFTkSuQmCC"/>
              <span class="text-xs text-gray-300">Bob building payments</span>
            </div>
          </div>

        </div>

      </div>
    </div>

    <div class="max-w-3xl mx-auto px-6">

      </div>
    </div>

    <!-- Multiplayer graphic: Slack on top, CLI sessions below, arrows between -->
    <div class="py-16 border-t border-gray-200">
      <div class="max-w-5xl mx-auto px-6">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider text-center">One channel, every session</h2>

        <!-- Row 1: Slack channel -->
        <div class="mt-8 max-w-[30rem] mx-auto bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
          <div class="border-b border-gray-200 px-4 py-2.5 bg-gray-50 flex items-center gap-2">
            <svg class="w-4 h-4 text-[#4A154B]" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>
            <span class="text-gray-900 font-bold text-sm"># webapp</span>
          </div>
          <div class="px-4 py-3 space-y-3 text-xs">
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">A</div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">Alice</span><span class="text-gray-400 text-[10px]">auth</span><span class="text-gray-400 text-[10px]">10:31</span></div>
                <p class="text-gray-700">implement auth middleware with RS256</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-blue-200 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-4 h-4 text-blue-600" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1" width="10" height="7" rx="1"/><rect x="1" y="5" width="14" height="2"/><rect x="5" y="4" width="2" height="1" fill="#bfdbfe"/><rect x="9" y="4" width="2" height="1" fill="#bfdbfe"/><rect x="4" y="8" width="2" height="3"/><rect x="7" y="8" width="2" height="3"/><rect x="10" y="8" width="2" height="3"/></svg></div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">agent.alice</span><span class="text-gray-400 text-[10px]">10:31</span></div>
                <p class="text-gray-700">Creating <code class="bg-gray-100 px-1 rounded text-red-600 text-[10px]">src/middleware/auth.ts</code>...</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-orange-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">B</div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">Bob</span><span class="text-gray-400 text-[10px]">payments</span><span class="text-gray-400 text-[10px]">10:32</span></div>
                <p class="text-gray-700">add Stripe webhook handler</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-orange-200 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-4 h-4 text-orange-600" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1" width="10" height="7" rx="1"/><rect x="1" y="5" width="14" height="2"/><rect x="5" y="4" width="2" height="1" fill="#fed7aa"/><rect x="9" y="4" width="2" height="1" fill="#fed7aa"/><rect x="4" y="8" width="2" height="3"/><rect x="7" y="8" width="2" height="3"/><rect x="10" y="8" width="2" height="3"/></svg></div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">agent.bob</span><span class="text-gray-400 text-[10px]">10:32</span></div>
                <p class="text-gray-700">Creating <code class="bg-gray-100 px-1 rounded text-red-600 text-[10px]">src/api/webhooks/stripe.ts</code>...</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-orange-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">B</div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">Bob</span><span class="text-gray-400 text-[10px]">&rarr; auth</span><span class="text-gray-400 text-[10px]">10:33</span></div>
                <p class="text-gray-700"><span class="text-blue-600 font-medium">@agent.alice</span> don't forget rate limiting on that endpoint</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">A</div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">Alice</span><span class="text-gray-400 text-[10px]">&rarr; payments</span><span class="text-gray-400 text-[10px]">10:33</span></div>
                <p class="text-gray-700"><span class="text-blue-600 font-medium">@agent.bob</span> use the shared secret from vault, not env vars</p>
              </div>
            </div>
            <div class="flex gap-2">
              <div class="w-6 h-6 rounded bg-blue-200 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-4 h-4 text-blue-600" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1" width="10" height="7" rx="1"/><rect x="1" y="5" width="14" height="2"/><rect x="5" y="4" width="2" height="1" fill="#bfdbfe"/><rect x="9" y="4" width="2" height="1" fill="#bfdbfe"/><rect x="4" y="8" width="2" height="3"/><rect x="7" y="8" width="2" height="3"/><rect x="10" y="8" width="2" height="3"/></svg></div>
              <div>
                <div class="flex items-baseline gap-1.5"><span class="text-gray-900 font-bold">agent.alice</span><span class="text-gray-400 text-[10px]">10:33</span></div>
                <p class="text-gray-700">Good call. Adding rate limiter...</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Arrows -->
        <div class="max-w-[30rem] mx-auto grid grid-cols-2 gap-4 py-3">
          <div class="flex justify-center">
            <svg class="w-6 h-10 text-gray-300" viewBox="0 0 24 40" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 4 L8 36 M4 8 L8 4 L12 8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M16 36 L16 4 M12 32 L16 36 L20 32" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="flex justify-center">
            <svg class="w-6 h-10 text-gray-300" viewBox="0 0 24 40" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 4 L8 36 M4 8 L8 4 L12 8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M16 36 L16 4 M12 32 L16 36 L20 32" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>

        <!-- Row 2: CLI sessions -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

          <!-- Alice's terminal -->
          <div class="bg-gray-900 rounded-xl overflow-hidden shadow-xl">
            <div class="flex items-center gap-1.5 px-4 py-2.5 bg-gray-800">
              <div class="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
              <div class="w-2.5 h-2.5 rounded-full bg-yellow-500/80"></div>
              <div class="w-2.5 h-2.5 rounded-full bg-green-500/80"></div>
              <span class="ml-2 text-xs text-gray-500 font-mono">alice &mdash; claude code</span>
            </div>
            <div class="px-4 py-3 font-mono text-xs leading-relaxed space-y-2">
              <div>
                <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">/polaris join #webapp</span>
              </div>
              <div class="text-gray-500">  Connected as alice/auth</div>
              <div class="border-t border-gray-700 pt-2">
                <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">implement auth middleware with RS256</span>
              </div>
              <div class="text-gray-400">  Creating src/middleware/auth.ts with RS256 JWT verification...</div>
              <div class="pl-3 border-l-2 border-orange-500/50">
                <span class="text-orange-400 text-[10px]">bob via slack</span>
                <span class="text-gray-400"> &mdash; don't forget rate limiting</span>
              </div>
              <div class="text-gray-400">  Good call. Adding rate limiter...</div>
            </div>
          </div>

          <!-- Bob's terminal -->
          <div class="bg-gray-900 rounded-xl overflow-hidden shadow-xl">
            <div class="flex items-center gap-1.5 px-4 py-2.5 bg-gray-800">
              <div class="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
              <div class="w-2.5 h-2.5 rounded-full bg-yellow-500/80"></div>
              <div class="w-2.5 h-2.5 rounded-full bg-green-500/80"></div>
              <span class="ml-2 text-xs text-gray-500 font-mono">bob &mdash; claude code</span>
            </div>
            <div class="px-4 py-3 font-mono text-xs leading-relaxed space-y-2">
              <div>
                <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">/polaris join #webapp</span>
              </div>
              <div class="text-gray-500">  Connected as bob/payments</div>
              <div class="border-t border-gray-700 pt-2">
                <span class="text-polaris-400">&gt;</span> <span class="text-gray-300">add Stripe webhook handler</span>
              </div>
              <div class="text-gray-400">  Creating src/api/webhooks/stripe.ts...</div>
              <div class="pl-3 border-l-2 border-blue-500/50">
                <span class="text-blue-400 text-[10px]">alice via slack</span>
                <span class="text-gray-400"> &mdash; use the shared secret from vault</span>
              </div>
              <div class="text-gray-400">  Pulling webhook secret from vault...</div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- What you can do with Polaris -->
    <div class="py-16 border-t border-gray-200">
      <div class="max-w-3xl mx-auto px-6">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">What you can do with Polaris</h2>

        <div class="mt-8 space-y-8">
          <div>
            <h3 class="font-semibold text-gray-900">Start streaming your session</h3>
            <div class="mt-2 bg-gray-900 text-gray-300 text-sm px-4 py-2.5 rounded-lg font-mono"><span class="text-polaris-400">&gt;</span> /polaris join #webapp</div>
            <p class="mt-2 text-sm text-gray-500">Every prompt, response, and tool call streams to your team's Slack channel in real time.</p>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Pull a teammate into your session</h3>
            <div class="mt-2 bg-gray-900 text-gray-300 text-sm px-4 py-2.5 rounded-lg font-mono"><span class="text-polaris-400">&gt;</span> /polaris tag @bob I need your input on this auth approach</div>
            <p class="mt-2 text-sm text-gray-500">Bob gets notified in Slack with full context. His reply appears inline in your terminal.</p>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Catch up on a teammate's session</h3>
            <div class="mt-2 bg-white border border-gray-200 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <svg class="w-4 h-4 text-[#4A154B] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>
              <span class="text-sm text-gray-700 font-mono"><span class="text-blue-600 font-medium">@polaris</span> summarize alice last 2h</span>
            </div>
            <p class="mt-2 text-sm text-gray-500">Get a summary of what happened — what was built, what decisions were made, what's still in progress.</p>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Redirect an agent from Slack</h3>
            <div class="mt-2 bg-white border border-gray-200 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <svg class="w-4 h-4 text-[#4A154B] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>
              <span class="text-sm text-gray-700 font-mono"><span class="text-blue-600 font-medium">@agent.alice</span> use RS256, not HS256 &mdash; we need asymmetric keys</span>
            </div>
            <p class="mt-2 text-sm text-gray-500">Your message lands directly in Alice's coding session. The agent picks it up and adjusts.</p>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Attach session context to a PR</h3>
            <div class="mt-2 bg-gray-900 text-gray-300 text-sm px-4 py-2.5 rounded-lg font-mono"><span class="text-polaris-400">&gt;</span> /polaris attach-pr #482</div>
            <p class="mt-2 text-sm text-gray-500">Adds a session transcript — prompts, decisions, and reasoning — to the pull request. Reviewers see the "why," not just the "what."</p>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Search past sessions</h3>
            <div class="mt-2 bg-white border border-gray-200 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <svg class="w-4 h-4 text-[#4A154B] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.523h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z"/></svg>
              <span class="text-sm text-gray-700 font-mono"><span class="text-blue-600 font-medium">@polaris</span> search "webhook secret rotation"</span>
            </div>
            <p class="mt-2 text-sm text-gray-500">Find when and why a decision was made, across all sessions.</p>
          </div>
        </div>

      </div>
    </div>

    <!-- Why Polaris -->
    <div class="">
      <!-- Banner -->
      <div class="bg-gray-900 px-6 py-12 text-center">
        <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wider">Why Polaris</h2>
        <p class="mt-4 text-2xl font-bold text-white leading-snug max-w-2xl mx-auto">Your prompts are the most valuable artifact in your engineering workflow.</p>
        <p class="mt-4 text-sm text-gray-400 max-w-xl mx-auto">Every prompt carries intent, context, and decision-making that no commit message can reconstruct. Today, all of it vanishes when the session ends.</p>
      </div>

      <!-- Pain points -->
      <div class="max-w-3xl mx-auto px-6 py-10 space-y-0">
        <div class="flex items-start gap-6 py-6 border-b border-gray-100">
          <div class="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"/></svg>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">AI sessions are invisible</h3>
            <p class="mt-1 text-sm text-gray-500">When someone's coding with an AI agent, the rest of the team has no idea what's happening. It's pair programming behind a locked door.</p>
          </div>
        </div>
        <div class="flex items-start gap-6 py-6 border-b border-gray-100">
          <div class="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Knowledge evaporates</h3>
            <p class="mt-1 text-sm text-gray-500">The full reasoning chain — why the agent chose one approach over another, what it tried and rejected — disappears with the session. Only the final code survives.</p>
          </div>
        </div>
        <div class="flex items-start gap-6 py-6 border-b border-gray-100">
          <div class="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Feedback comes too late</h3>
            <p class="mt-1 text-sm text-gray-500">Teammates see the pull request, not the process. By then the agent has already committed to a path that one Slack message could have redirected.</p>
          </div>
        </div>
        <div class="flex items-start gap-6 py-6">
          <div class="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
          </div>
          <div>
            <h3 class="font-semibold text-gray-900">Multiple agents, zero shared context</h3>
            <p class="mt-1 text-sm text-gray-500">Teams running concurrent AI sessions have no coordination layer. Alice's agent doesn't know what Bob's agent is building, leading to conflicts and duplicated work.</p>
          </div>
        </div>
      </div>

      <!-- Resolution -->
      <div class="bg-gray-50">
        <div class="max-w-3xl mx-auto px-6 py-8">
          <p class="text-sm text-gray-700"><span class="font-semibold text-gray-900">Polaris fixes this.</span> Every prompt, every response, every tool call — captured, streamed to your team in real time, and stored as permanent memory. Teammates can intervene mid-session. Agents across sessions share context through the hub. Nothing is lost.</p>
        </div>
      </div>
    </div>

    <!-- The Vision -->
    <div class="py-16 border-t border-gray-200">
      <div class="max-w-3xl mx-auto px-6">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider text-center">The vision</h2>
        <p class="mt-6 text-gray-700 text-center max-w-2xl mx-auto">Tobi Lutke, CEO of Shopify, recently described a future where every AI interaction in an organization flows through a shared, observable stream — what he calls "the shop floor." The vision he articulates is strikingly close to what Polaris already does.</p>

        <div class="mt-8 flex justify-center">
          <a href="https://x.com/tobi/article/2053121182044451016" target="_blank" class="block max-w-md w-full bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition overflow-hidden">
            <div class="px-6 py-5">
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                <span>Article</span>
              </div>
              <h3 class="mt-3 text-lg font-bold text-gray-900 leading-snug">Learning on the Shop Floor</h3>
              <p class="mt-1 text-sm text-gray-500">by Tobi Lutke &middot; May 9, 2026</p>
              <p class="mt-3 text-xs text-polaris-600 font-medium">Read on X &rarr;</p>
            </div>
          </a>
        </div>

        <p class="mt-8 text-gray-700 text-center max-w-2xl mx-auto">The idea behind Polaris was born independently, but the convergence isn't a coincidence. As AI agents become central to how software gets built, the need for this layer — variously called a <em>context graph</em>, a <em>memory layer</em>, <em>institutional memory</em>, or <em>decision traces</em> — becomes inevitable. A persistent, searchable record of every prompt, every decision, every session. Polaris is building that layer.</p>

      </div>
    </div>

    <div class="max-w-3xl mx-auto px-6">

      <!-- How it works -->
      <div class="py-16 border-t border-gray-200">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">How it works</h2>
        <div class="mt-8 space-y-8">
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">1</div>
            <div>
              <h3 class="font-semibold text-gray-900">Connect</h3>
              <p class="mt-1 text-sm text-gray-500">Sign up and connect your team's Slack workspace. Polaris uses Slack as the collaboration layer — no new apps to learn.</p>
            </div>
          </div>
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">2</div>
            <div>
              <h3 class="font-semibold text-gray-900">Install</h3>
              <p class="mt-1 text-sm text-gray-500"><code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 text-xs">npx @lightupai/polaris</code> on your machine sets up hooks, MCP server, and logs you in.</p>
            </div>
          </div>
          <div class="flex gap-4">
            <div class="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center text-white text-sm font-bold shrink-0">3</div>
            <div>
              <h3 class="font-semibold text-gray-900">Collaborate</h3>
              <p class="mt-1 text-sm text-gray-500"><code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 text-xs">/polaris join #your-channel</code> links your Claude Code session to Slack. Every prompt and response streams live — teammates reply there and their messages appear inline.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom CTA -->
      <div class="py-16 border-t border-gray-200 text-center">
        <h2 class="text-2xl font-bold text-gray-900">Ready to try it?</h2>
        <p class="mt-2 text-sm text-gray-500">Set up takes less than two minutes.</p>
        <div class="mt-6">
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
