// --- View functions for dashboard states ---
// All views follow three consistent sections: Floor, Devices, Projects & Sessions.

import { nav, slackIcon, type NavOpts } from "./layout";
import type { SessionFixture, ProjectFixture, DeviceFixture } from "./fixtures";

interface ViewContext {
  token: string;
  userName: string;
  orgName: string;
  orgSlug: string | null;
  email: string;
  slackConnected: boolean;
  cliInstalled: boolean;
  hasConnectedSession: boolean;
  totalPrompts: number;
}

function navOpts(ctx: { userName: string; orgName: string; email: string }): NavOpts {
  return { userName: ctx.userName, orgName: ctx.orgName, email: ctx.email };
}

// Minimal context for pages that don't need the full dashboard state (transcript, search).
export interface PageContext {
  token: string;
  userName: string;
  orgName: string;
  email: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Copyable code block ---

function copyBlock(text: string): string {
  const id = `copy-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div class="mt-3 relative">
      <code id="${id}" class="block bg-gray-50 border border-gray-200 rounded px-3 py-2 pr-10 text-xs font-mono select-all">${text}</code>
      <button data-copy="${id}" class="polaris-copy absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition rounded" title="Copy">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
      </button>
    </div>`;
}

// --- Shared section renderers ---

function sectionHeader(title: string): string {
  return `<h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${title}</h2>`;
}

function statusBadge(label: string, done: boolean): string {
  return done
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
         <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
         ${label}
       </span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">${label}</span>`;
}

// --- Floor section ---

type StepState = "done" | "active" | "future";

function cardClass(state: StepState): string {
  if (state === "active") return "border-polaris-300 bg-polaris-50/30 shadow-sm";
  return "border-gray-200";
}

function sectionWrap(state: StepState, content: string): string {
  if (state === "future") return `<div class="opacity-40 pointer-events-none">${content}</div>`;
  return content;
}

function renderFloorSection(ctx: ViewContext, compact = false, state: StepState = "done"): string {
  if (compact && ctx.slackConnected) {
    const promptStat = ctx.totalPrompts > 0
      ? `<span class="text-xs text-gray-400 ml-auto">${ctx.totalPrompts} prompt${ctx.totalPrompts !== 1 ? "s" : ""}</span>`
      : '';
    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Floor</h2>
          ${statusBadge("Connected", true)}
        </div>
        <div class="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
            ${slackIcon.replace('class="w-4 h-4"', 'class="w-4 h-4 text-white"')}
          </div>
          <p class="text-sm font-medium text-gray-900">Slack</p>
          ${ctx.orgSlug ? `<span class="text-xs text-gray-400 font-mono">${ctx.orgSlug}</span>` : ''}
          ${promptStat}
        </div>
      </div>`;
  }

  if (ctx.slackConnected) {
    const slugLabel = ctx.orgSlug
      ? `<span class="text-xs text-gray-400 font-mono">${ctx.orgSlug}</span>`
      : '';

    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Floor</h2>
          ${statusBadge("Connected", true)}
        </div>
        <div class="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
            ${slackIcon.replace('class="w-4 h-4"', 'class="w-4 h-4 text-white"')}
          </div>
          <p class="text-sm font-medium text-gray-900">Slack</p>
          ${slugLabel}
        </div>
      </div>`;
  }

  return sectionWrap(state, `
    <div>
      <div class="flex items-baseline gap-2 mb-3">
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Floor</h2>
        ${statusBadge("Not connected", false)}
      </div>
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-amber-200"} rounded-lg p-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
          </div>
          <div>
            <p class="text-sm font-semibold text-gray-900">Slack</p>
            <p class="text-sm text-gray-500 mt-0.5">Connect your Slack workspace to enable the floor for your team.</p>
          </div>
        </div>
        <a href="/slack/install?token=${ctx.token}" class="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-[#4A154B] text-white text-sm font-medium rounded-lg hover:bg-[#3a1039] transition">
          ${slackIcon}
          Connect Slack
        </a>
      </div>
    </div>`);
}

// --- Devices section ---

function renderDevicesSection(ctx: ViewContext, devices: DeviceFixture[], state: StepState = "done"): string {
  if (devices.length > 0) {
    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Devices</h2>
          ${statusBadge(`${devices.length} connected`, true)}
        </div>
        <details class="mb-3">
          <summary class="text-xs text-polaris-700 hover:text-polaris-800 font-medium cursor-pointer select-none">+ Add another device</summary>
          <div class="mt-2 bg-white border border-gray-200 rounded-lg p-4">
            <p class="text-sm text-gray-500">Run on any new machine:</p>
            ${copyBlock("npx @lightupai/polaris")}
          </div>
        </details>
        <div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          ${devices.map((d) => renderDeviceRow(d)).join("")}
        </div>
      </div>`;
  }

  // Setup state — no devices yet
  return sectionWrap(state, `
    <div>
      <div class="flex items-baseline gap-2 mb-3">
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Devices</h2>
        ${ctx.cliInstalled ? statusBadge("Installed", true) : statusBadge("Not installed", false)}
      </div>
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-gray-200"} rounded-lg p-5">
        <p class="text-sm font-semibold text-gray-900">${ctx.cliInstalled ? "Add another device" : "Set up Polaris on your first device"}</p>
        <p class="text-sm text-gray-500 mt-1">Run this in your terminal${ctx.cliInstalled ? " on any new machine" : ". Repeat on each machine you work from"}.</p>
        ${copyBlock("npx @lightupai/polaris")}
      </div>
    </div>`);
}

function renderDeviceRow(device: DeviceFixture): string {
  const recentThreshold = Date.now() - 60 * 60 * 1000; // 1 hour
  const isOnline = device.activeSession || new Date(device.lastSeen).getTime() > recentThreshold;
  return `
    <div class="p-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <p class="text-sm font-medium text-gray-900">${device.name}</p>
            ${isOnline
              ? '<span class="w-2 h-2 rounded-full bg-green-500"></span>'
              : '<span class="w-2 h-2 rounded-full bg-gray-300"></span>'}
          </div>
          <p class="text-xs text-gray-400">${device.os}</p>
        </div>
      </div>
      <div class="text-right">
        ${device.activeSession ? `<p class="text-xs font-medium text-gray-700">${device.activeSession}</p>` : ""}
        <p class="text-xs text-gray-400">${isOnline ? "Online" : "Offline"} · ${new Date(device.lastSeen).toLocaleString()}</p>
      </div>
    </div>`;
}

// --- Projects & Sessions section ---

function renderProjectsSessionsSection(ctx: ViewContext, sessions: SessionFixture[], projects: ProjectFixture[], state: StepState = "done"): string {
  if (projects.length > 0) {
    const totalSessions = projects.reduce((n, p) => n + p.sessions.length, 0);
    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Projects & Sessions</h2>
          ${statusBadge(`${totalSessions} active`, true)}
        </div>
        <details class="mb-3">
          <summary class="text-xs text-polaris-700 hover:text-polaris-800 font-medium cursor-pointer select-none">+ Join another session</summary>
          <div class="mt-2 bg-white border border-gray-200 rounded-lg p-4">
            <p class="text-sm text-gray-500">Inside your AI agent, run:</p>
            ${copyBlock("/polaris join &lt;project&gt;")}
          </div>
        </details>
        <div class="space-y-4">
          ${projects.map((p) => renderProjectCard(p, ctx.userName, ctx.token)).join("")}
        </div>
      </div>`;
  }

  // Setup state — no sessions yet
  return sectionWrap(state, `
    <div>
      <div class="flex items-baseline gap-2 mb-3">
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Projects & Sessions</h2>
        ${ctx.hasConnectedSession ? statusBadge("Connected", true) : statusBadge("Waiting", false)}
      </div>
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-gray-200"} rounded-lg p-5">
        <p class="text-sm font-semibold text-gray-900">Connect your first session</p>
        <p class="text-sm text-gray-500 mt-1">${ctx.hasConnectedSession
          ? "You've connected a session. You're ready to collaborate."
          : "Inside your AI agent (Claude Code, Cursor, etc.), run:"}</p>
        ${ctx.hasConnectedSession
          ? ""
          : copyBlock("/polaris join my-project")}
      </div>
    </div>`);
}

function renderProjectCard(project: ProjectFixture, userName: string, token: string): string {
  const sessionCount = project.sessions.length;
  const participantId = `user:${userName.toLowerCase().replace(/\s+/g, ".")}`;

  return `
    <div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div class="px-4 py-3 flex items-center justify-between border-b border-gray-100">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold text-gray-900">${project.name}</p>
          ${project.slackChannel ? `<span class="text-xs text-gray-400">${project.slackChannel}</span>` : ""}
        </div>
        <span class="text-xs text-gray-400">${sessionCount} session${sessionCount !== 1 ? "s" : ""}</span>
      </div>
      <div class="divide-y divide-gray-50">
        ${project.sessions.map((s) => {
          const isDriver = s.driver === participantId;
          const roleBadge = isDriver
            ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-polaris-100 text-polaris-800">Driver</span>'
            : s.driver
              ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Advisor</span>'
              : '';
          const driverLabel = s.driver && !isDriver
            ? `<span class="text-xs text-gray-400">${s.driver}</span>`
            : '';
          const promptLabel = s.eventCount > 0
            ? `<span class="text-xs text-gray-400">${s.eventCount} prompt${s.eventCount !== 1 ? "s" : ""}</span>`
            : '';
          const transcriptHref = `/sessions/${encodeURIComponent(project.name)}/${encodeURIComponent(s.name)}?token=${token}`;
          return `
            <div class="px-4 py-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-2 h-2 rounded-full bg-green-500"></div>
                <a href="${transcriptHref}" class="text-sm text-gray-700 hover:text-polaris-700 hover:underline">${s.name}</a>
                ${roleBadge}
              </div>
              <div class="flex items-center gap-3">
                ${driverLabel}
                ${promptLabel}
                <a href="${transcriptHref}" class="text-xs font-medium text-polaris-700 hover:text-polaris-800">Transcript</a>
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

// --- Auto-refresh script ---

function autoRefreshScript(token: string): string {
  return `
    <script>
    (function() {
      const evtSource = new EventSource('/api/dashboard-events?token=${token}');
      evtSource.onmessage = function(e) {
        if (e.data === 'refresh') window.location.reload();
      };
    })();
    </script>`;
}

// --- Setup view (zero state) ---
// Same three sections, but each shows its setup prompt instead of live data.

export function renderSetupView(ctx: ViewContext, devices: DeviceFixture[] = []): string {
  const nextStep = !ctx.slackConnected ? "floor" : !ctx.cliInstalled ? "devices" : "sessions";
  const stepState = (step: string): "done" | "active" | "future" => {
    const order = ["floor", "devices", "sessions"];
    const nextIdx = order.indexOf(nextStep);
    const thisIdx = order.indexOf(step);
    if (thisIdx < nextIdx) return "done";
    if (thisIdx === nextIdx) return "active";
    return "future";
  };

  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 space-y-10">
      ${renderFloorSection(ctx, false, stepState("floor"))}
      ${renderDevicesSection(ctx, ctx.cliInstalled ? devices : [], stepState("devices"))}
      ${renderProjectsSessionsSection(ctx, [], [], stepState("sessions"))}
    </div>
    ${autoRefreshScript(ctx.token)}`;
}

// --- Error view ---

export function renderErrorView(message: string, linkText?: string, linkHref?: string): string {
  return `
    ${nav()}
    <div class="max-w-md mx-auto px-6 pt-24">
      <div class="bg-white border border-red-200 rounded-lg p-6 text-center">
        <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
          <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
        </div>
        <p class="text-sm text-red-700">${message}</p>
        ${linkText && linkHref ? `<a href="${linkHref}" class="mt-4 inline-block text-sm font-medium text-polaris-700 hover:text-polaris-800">${linkText}</a>` : ""}
      </div>
    </div>`;
}

// --- Active view (user has sessions) ---
// Same three sections, populated with live data.

export function renderActiveView(ctx: ViewContext, sessions: SessionFixture[], projects: ProjectFixture[], devices: DeviceFixture[] = []): string {
  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 space-y-10">
      ${renderFloorSection(ctx, true)}
      ${renderDevicesSection(ctx, devices)}
      ${renderProjectsSessionsSection(ctx, sessions, projects)}
    </div>
    ${autoRefreshScript(ctx.token)}`;
}

// --- Profile view ---

export function renderProfileView(ctx: ViewContext, participantId: string): string {
  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12">
      <div>
        ${sectionHeader("Profile")}
        <div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          <div class="p-5 flex items-center gap-4">
            <div class="w-12 h-12 rounded-full bg-polaris-600 flex items-center justify-center text-white text-lg font-bold shrink-0">${ctx.userName.charAt(0).toUpperCase()}</div>
            <div>
              <p class="text-sm font-semibold text-gray-900">${ctx.userName}</p>
              <p class="text-sm text-gray-500">${ctx.email}</p>
            </div>
          </div>
          <div class="p-5 flex items-center justify-between">
            <div>
              <p class="text-xs text-gray-400">Participant ID</p>
              <p class="text-sm font-mono text-gray-700">${participantId}</p>
            </div>
            <div class="text-right">
              <p class="text-xs text-gray-400">Organization</p>
              <p class="text-sm text-gray-700">${ctx.orgName}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-10">
        ${sectionHeader("API token")}
        <div class="bg-white border border-gray-200 rounded-lg p-5">
          <p class="text-sm text-gray-500 mb-3">Use this for scripts and direct API access. The <code class="bg-gray-100 px-1 rounded text-xs">polaris login</code> CLI handles this automatically.</p>
          ${copyBlock(ctx.token)}
        </div>
      </div>
    </div>`;
}

// --- Session transcript view ---
// Events arrive from the API newest-first ({ events, nextCursor }); we render ascending.

export interface TranscriptEvent {
  id: string;
  project: string;
  session: string;
  timestamp: string;
  source: string;
  sender: string;
  payload: Record<string, unknown>;
}

interface EventPayload {
  hook_event_name?: string;
  prompt?: string;
  stop_response?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  content?: string;
}

function eventMeta(e: TranscriptEvent): string {
  return `<span class="text-xs text-gray-400">${escapeHtml(e.sender)} &middot; ${new Date(e.timestamp).toLocaleString()}</span>`;
}

function messageCard(badge: string, badgeClass: string, e: TranscriptEvent, text: string, cardClass = "bg-white border border-gray-200"): string {
  return `
    <div class="${cardClass} rounded-lg px-4 py-3">
      <div class="flex items-baseline gap-2">
        <span class="px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}">${badge}</span>
        ${eventMeta(e)}
      </div>
      <p class="mt-1.5 text-sm text-gray-800 whitespace-pre-wrap">${escapeHtml(text)}</p>
    </div>`;
}

function renderTranscriptItem(e: TranscriptEvent): string {
  const p = e.payload as EventPayload;

  if (e.source === "inject") {
    return `
      <div class="border-l-4 border-amber-400 bg-amber-50 rounded-r-lg px-4 py-3">
        <div class="flex items-baseline gap-2">
          <span class="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">Inject</span>
          ${eventMeta(e)}
        </div>
        <p class="mt-1.5 text-sm text-gray-800 whitespace-pre-wrap">[${escapeHtml(e.sender)}] ${escapeHtml(p.content ?? "")}</p>
      </div>`;
  }

  if (e.source === "reply") {
    return messageCard("Reply", "bg-gray-100 text-gray-600", e, p.content ?? "");
  }

  if (typeof p.prompt === "string") {
    return messageCard("Prompt", "bg-polaris-100 text-polaris-800", e, p.prompt);
  }

  if (typeof p.tool_name === "string") {
    const detail = p.hook_event_name === "PostToolUse" ? p.tool_result : p.tool_input;
    let detailText = "";
    try { detailText = JSON.stringify(detail, null, 2) ?? ""; } catch { detailText = String(detail); }
    return `
      <details class="px-1">
        <summary class="flex items-baseline gap-2 py-1 text-xs text-gray-400 hover:text-gray-600 cursor-pointer select-none">
          <span class="font-mono text-gray-500">${escapeHtml(p.tool_name)}</span>
          <span>${p.hook_event_name === "PostToolUse" ? "result" : "tool call"}</span>
          <span class="ml-auto">${eventMeta(e)}</span>
        </summary>
        ${detailText ? `<pre class="mt-1 mb-2 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">${escapeHtml(detailText)}</pre>` : ""}
      </details>`;
  }

  const response = typeof p.stop_response === "string" && p.stop_response ? p.stop_response : p.last_assistant_message;
  if (typeof response === "string" && response) {
    return messageCard("Agent", "bg-green-100 text-green-800", e, response, "bg-white border border-gray-200");
  }

  return "";
}

export function renderTranscriptView(
  ctx: PageContext,
  project: string,
  session: string,
  events: TranscriptEvent[],
  nextCursor: string | null,
  before?: string
): string {
  const base = `/sessions/${encodeURIComponent(project)}/${encodeURIComponent(session)}`;
  const items = [...events].reverse().map(renderTranscriptItem).filter((html) => html !== "").join("\n");

  const pagingLinks = [
    before ? `<a href="${base}?token=${ctx.token}" class="text-xs font-medium text-polaris-700 hover:text-polaris-800">Back to latest</a>` : "",
    nextCursor ? `<a href="${base}?token=${ctx.token}&before=${encodeURIComponent(nextCursor)}" class="text-xs font-medium text-polaris-700 hover:text-polaris-800">Load older</a>` : "",
  ].filter(Boolean).join("");

  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 pb-16 space-y-10">
      <div>
        ${sectionHeader("Session transcript")}
        <div class="flex items-baseline justify-between mb-4">
          <h1 class="text-2xl font-bold text-gray-900">${escapeHtml(session)}</h1>
          <span class="text-sm text-gray-400 font-mono">${escapeHtml(project)}</span>
        </div>
        ${pagingLinks ? `<div class="flex items-center gap-4 mb-3">${pagingLinks}</div>` : ""}
        ${items
          ? `<div class="space-y-3">${items}</div>`
          : `<div class="bg-white border border-gray-200 rounded-lg p-5 text-sm text-gray-500">No events captured for this session yet.</div>`}
      </div>

      <div>
        ${sectionHeader("Inject guidance")}
        <form method="POST" action="${base}/inject?token=${ctx.token}" class="bg-white border border-gray-200 rounded-lg p-5">
          <p class="text-sm text-gray-500 mb-3">Send a note to this session's agent. It is delivered with the next prompt.</p>
          <textarea name="content" rows="3" required placeholder="e.g. Use RS256, not HS256 &mdash; we need asymmetric keys" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-polaris-300 focus:border-polaris-300"></textarea>
          <button type="submit" class="mt-3 px-4 py-2 bg-polaris-700 text-white text-sm font-medium rounded-lg hover:bg-polaris-800 transition">Inject</button>
        </form>
      </div>
    </div>`;
}

// --- Search view ---

export interface SearchQuery {
  q: string;
  project: string;
  sender: string;
  source: string;
}

export interface SearchResult {
  event: TranscriptEvent;
  snippet: string;
}

// ts_headline marks matches with <b>...</b>; escape everything else, then restore the highlights.
function snippetHtml(snippet: string): string {
  return escapeHtml(snippet)
    .replace(/&lt;b&gt;/g, '<b class="font-semibold text-polaris-800 bg-polaris-100 rounded px-0.5">')
    .replace(/&lt;\/b&gt;/g, "</b>");
}

export function renderSearchView(ctx: PageContext, query: SearchQuery, results: SearchResult[] | null, searchError?: string): string {
  const inputClass = "border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-polaris-300 focus:border-polaris-300";
  const sourceOptions = ["", "hook", "inject", "reply"]
    .map((s) => `<option value="${s}"${s === query.source ? " selected" : ""}>${s === "" ? "Any source" : s}</option>`)
    .join("");

  let resultsSection = "";
  if (searchError) {
    resultsSection = `<div class="bg-white border border-red-200 rounded-lg p-5 text-sm text-red-700">${escapeHtml(searchError)}</div>`;
  } else if (results !== null) {
    const resultItems = results.map(({ event, snippet }) => {
      const href = `/sessions/${encodeURIComponent(event.project)}/${encodeURIComponent(event.session)}?token=${ctx.token}`;
      return `
        <a href="${href}" class="block bg-white border border-gray-200 rounded-lg p-4 hover:border-polaris-300 hover:shadow-sm transition">
          <div class="flex items-baseline gap-2 text-xs text-gray-400">
            <span class="font-medium text-gray-700">${escapeHtml(event.sender)}</span>
            <span class="font-mono">${escapeHtml(event.project)}/${escapeHtml(event.session)}</span>
            <span class="ml-auto">${new Date(event.timestamp).toLocaleString()}</span>
          </div>
          <p class="mt-1.5 text-sm text-gray-700">${snippetHtml(snippet)}</p>
        </a>`;
    }).join("");
    resultsSection = results.length
      ? `<div>
           <p class="text-xs text-gray-400 mb-3">${results.length} result${results.length !== 1 ? "s" : ""} for &ldquo;${escapeHtml(query.q)}&rdquo;</p>
           <div class="space-y-3">${resultItems}</div>
         </div>`
      : `<div class="bg-white border border-gray-200 rounded-lg p-5 text-sm text-gray-500">No results for &ldquo;${escapeHtml(query.q)}&rdquo;.</div>`;
  }

  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 pb-16 space-y-6">
      <div>
        ${sectionHeader("Search")}
        <form method="GET" action="/search" class="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
          <input type="hidden" name="token" value="${ctx.token}">
          <div class="flex gap-2">
            <input name="q" value="${escapeHtml(query.q)}" placeholder="Search prompts, responses, and messages" class="flex-1 ${inputClass}">
            <button type="submit" class="px-4 py-2 bg-polaris-700 text-white text-sm font-medium rounded-lg hover:bg-polaris-800 transition">Search</button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input name="project" value="${escapeHtml(query.project)}" placeholder="Project" class="${inputClass}">
            <input name="sender" value="${escapeHtml(query.sender)}" placeholder="Sender (e.g. user:priya)" class="${inputClass}">
            <select name="source" class="bg-white ${inputClass}">${sourceOptions}</select>
          </div>
        </form>
      </div>
      ${resultsSection}
    </div>`;
}
