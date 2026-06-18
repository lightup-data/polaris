// --- View functions for dashboard states ---
// All views follow three consistent sections: Floor, Devices, Projects & Sessions.

import { nav, slackIcon, type NavOpts } from "./layout";
import type { SessionFixture, ProjectFixture, DeviceFixture } from "./fixtures";
import type { Annotation } from "../types";

interface TeamMember {
  name: string;
  email: string;
}

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
  teamMembers?: TeamMember[];
  plan?: string;
  dailyPrompts?: Array<{ date: string; sender: string; count: number }>;
}

function navOpts(ctx: { userName: string; orgName: string; email: string; plan?: string }): NavOpts {
  return { userName: ctx.userName, orgName: ctx.orgName, email: ctx.email, plan: ctx.plan, banner: bannerForCtx(ctx) };
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

const formInputClass = "border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-polaris-300 focus:border-polaris-300";

function statusBadge(label: string, done: boolean): string {
  return done
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
         <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
         ${label}
       </span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">${label}</span>`;
}

// --- Banner helpers ---

function bannerForCtx(ctx: { plan?: string }): { message: string; style: "info" | "success" | "warning" } | undefined {
  if (ctx.plan && ctx.plan !== "free") {
    const label = ctx.plan.charAt(0).toUpperCase() + ctx.plan.slice(1);
    return { message: `<strong>${label} plan</strong> — we'll reach out shortly to get you set up. Full access in the meantime.`, style: "info" };
  }
  return undefined;
}

// --- Team members ---

function renderTeamMembers(members: TeamMember[], currentEmail: string): string {
  if (members.length === 0) return "";
  return `
    <div class="mt-3 bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
      ${members.map((m) => {
        const isYou = m.email === currentEmail;
        return `
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="w-7 h-7 rounded-full bg-polaris-600 flex items-center justify-center text-white text-xs font-bold shrink-0">${m.name.charAt(0).toUpperCase()}</div>
            <p class="text-sm text-gray-900">${m.name}${isYou ? ' <span class="text-xs text-gray-400">(you)</span>' : ""}</p>
            <span class="text-xs text-gray-400 ml-auto">${m.email}</span>
          </div>`;
      }).join("")}
    </div>`;
}

// --- Daily prompts chart ---

function renderDailyPrompts(data: Array<{ date: string; sender: string; count: number }> | undefined): string {
  if (!data || data.length === 0) return "";

  const id = `heatmap-${Math.random().toString(36).slice(2, 8)}`;

  // Build date columns for last 14 days
  const dates: string[] = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Totals per day
  const dayTotals = new Map<string, number>();
  let total = 0;
  for (const d of data) {
    dayTotals.set(d.date, (dayTotals.get(d.date) ?? 0) + d.count);
    total += d.count;
  }

  // Group by sender
  const bySender = new Map<string, Map<string, number>>();
  for (const d of data) {
    if (!bySender.has(d.sender)) bySender.set(d.sender, new Map());
    bySender.get(d.sender)!.set(d.date, d.count);
  }

  function intensity(count: number, max: number): string {
    if (count === 0) return "bg-gray-100";
    const ratio = count / max;
    if (ratio < 0.25) return "bg-polaris-100";
    if (ratio < 0.5) return "bg-polaris-200";
    if (ratio < 0.75) return "bg-polaris-400";
    return "bg-polaris-600";
  }

  function shortName(sender: string): string {
    const name = sender.replace(/^user:/, "").split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // Team view — histogram bars
  const teamMax = Math.max(...dates.map((d) => dayTotals.get(d) ?? 0), 1);
  const teamBars = dates.map((date) => {
    const count = dayTotals.get(date) ?? 0;
    const pct = Math.max((count / teamMax) * 100, count > 0 ? 12 : 0);
    const label = date.slice(5).replace("-", "/");
    const day = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
    return `
      <div class="flex flex-col items-center gap-1 flex-1" title="${day} ${label}: ${count}">
        ${count > 0 ? `<span class="text-[9px] text-gray-400 leading-none">${count}</span>` : `<span class="text-[9px] leading-none">&nbsp;</span>`}
        <div class="w-full flex flex-col justify-end" style="height: 40px">
          <div class="w-full rounded-sm ${count > 0 ? "bg-polaris-400" : "bg-gray-100"}" style="height: ${pct}%"></div>
        </div>
        <span class="text-[8px] text-gray-400 leading-none">${label}</span>
      </div>`;
  }).join("");

  const teamView = `
    <div class="flex items-end gap-0.5">
      ${teamBars}
    </div>`;

  // Per-user view — each row uses its own max for color scale
  const userRows = Array.from(bySender.entries()).map(([sender, counts]) => {
    const rowMax = Math.max(...dates.map((d) => counts.get(d) ?? 0), 1);
    const cells = dates.map((date) => {
      const count = counts.get(date) ?? 0;
      const day = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
      return `<div class="h-5 flex-1 rounded-sm ${intensity(count, rowMax)}" title="${day} ${date.slice(5).replace("-", "/")}: ${count}"></div>`;
    }).join("");
    return `
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-gray-500 w-12 text-right shrink-0 truncate">${shortName(sender)}</span>
        <div class="flex items-center gap-px flex-1">${cells}</div>
      </div>`;
  }).join("");

  const dateLabels = dates.map((date) => {
    return `<div class="flex-1 text-center text-[8px] text-gray-400 leading-none">${date.slice(5).replace("-", "/")}</div>`;
  }).join("");

  const userView = `
    <div class="flex flex-col gap-1">
      ${userRows}
      <div class="flex items-center gap-2">
        <span class="w-12 shrink-0"></span>
        <div class="flex items-center gap-px flex-1">${dateLabels}</div>
      </div>
    </div>`;

  return `
    <div class="mt-3 bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-medium text-gray-500">Prompts captured</p>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400">${total} last 14d</span>
          <div class="flex items-center bg-gray-100 rounded-md p-0.5">
            <button id="${id}-btn-team" onclick="document.getElementById('${id}-team').classList.remove('hidden');document.getElementById('${id}-user').classList.add('hidden');this.classList.add('bg-white','shadow-sm','text-gray-700');this.classList.remove('text-gray-400');var o=document.getElementById('${id}-btn-user');o.classList.remove('bg-white','shadow-sm','text-gray-700');o.classList.add('text-gray-400')" class="text-[10px] font-medium px-2 py-0.5 rounded cursor-pointer bg-white shadow-sm text-gray-700">Team</button>
            <button id="${id}-btn-user" onclick="document.getElementById('${id}-user').classList.remove('hidden');document.getElementById('${id}-team').classList.add('hidden');this.classList.add('bg-white','shadow-sm','text-gray-700');this.classList.remove('text-gray-400');var o=document.getElementById('${id}-btn-team');o.classList.remove('bg-white','shadow-sm','text-gray-700');o.classList.add('text-gray-400')" class="text-[10px] font-medium px-2 py-0.5 rounded cursor-pointer text-gray-400">By user</button>
          </div>
        </div>
      </div>
      <div id="${id}-team">${teamView}</div>
      <div id="${id}-user" class="hidden">${userView}</div>
    </div>`;
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
    const teamCount = ctx.teamMembers?.length ?? 0;
    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Floor</h2>
          ${statusBadge("Connected", true)}
          ${teamCount > 0 ? `<span class="text-xs text-gray-400">${teamCount} member${teamCount !== 1 ? "s" : ""}</span>` : ""}
        </div>
        <div class="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
            ${slackIcon.replace('class="w-4 h-4"', 'class="w-4 h-4 text-white"')}
          </div>
          <p class="text-sm font-medium text-gray-900">Slack</p>
          ${ctx.orgSlug ? `<span class="text-xs text-gray-400 font-mono">${ctx.orgSlug}</span>` : ''}
          ${promptStat}
        </div>
        ${renderDailyPrompts(ctx.dailyPrompts)}
        ${ctx.teamMembers ? renderTeamMembers(ctx.teamMembers, ctx.email) : ""}
      </div>`;
  }

  if (ctx.slackConnected) {
    const slugLabel = ctx.orgSlug
      ? `<span class="text-xs text-gray-400 font-mono">${ctx.orgSlug}</span>`
      : '';
    const teamCount = ctx.teamMembers?.length ?? 0;

    return `
      <div>
        <div class="flex items-baseline gap-2 mb-3">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Floor</h2>
          ${statusBadge("Connected", true)}
          ${teamCount > 0 ? `<span class="text-xs text-gray-400">${teamCount} member${teamCount !== 1 ? "s" : ""}</span>` : ""}
        </div>
        <div class="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
            ${slackIcon.replace('class="w-4 h-4"', 'class="w-4 h-4 text-white"')}
          </div>
          <p class="text-sm font-medium text-gray-900">Slack</p>
          ${slugLabel}
        </div>
        ${renderDailyPrompts(ctx.dailyPrompts)}
        ${ctx.teamMembers ? renderTeamMembers(ctx.teamMembers, ctx.email) : ""}
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
            ${copyBlock("/polaris join #channel-name")}
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
          : copyBlock("/polaris join #my-channel")}
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
        <div class="flex items-center gap-3">
          <span class="text-xs text-gray-400">${sessionCount} session${sessionCount !== 1 ? "s" : ""}</span>
          <a href="/projects/${encodeURIComponent(project.name)}/settings?token=${token}" class="text-xs font-medium text-gray-400 hover:text-polaris-700">Settings</a>
        </div>
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

// --- Annotation controls (star / tag / decision curation) ---

// Short excerpt of the event's main text, used as the default note when marking a decision.
function eventExcerpt(e: TranscriptEvent): string {
  const p = e.payload as EventPayload;
  const text =
    typeof p.prompt === "string" ? p.prompt
    : typeof p.content === "string" ? p.content
    : typeof p.stop_response === "string" && p.stop_response ? p.stop_response
    : typeof p.last_assistant_message === "string" ? p.last_assistant_message
    : "";
  return text.slice(0, 200);
}

function annotationForm(action: string, fields: Record<string, string>, button: string): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  return `<form method="POST" action="${action}" class="inline-flex">${inputs}${button}</form>`;
}

function renderAnnotationControls(e: TranscriptEvent, annotations: Annotation[], base: string, token: string): string {
  const own = annotations.filter((a) => a.event_id === e.id);
  const star = own.find((a) => a.kind === "star");
  const tags = own.filter((a) => a.kind === "tag");
  const decision = own.find((a) => a.kind === "decision");
  const addAction = `${base}/annotations?token=${token}`;
  const deleteAction = (id: string) => `${base}/annotations/${encodeURIComponent(id)}/delete?token=${token}`;

  const starControl = star
    ? annotationForm(deleteAction(star.id), {}, `<button type="submit" class="text-xs font-medium text-amber-500 hover:text-amber-600" title="Remove star">&#9733; Starred</button>`)
    : annotationForm(addAction, { event_id: e.id, kind: "star" }, `<button type="submit" class="text-xs text-gray-400 hover:text-amber-600" title="Star this event">&#9734; Star</button>`);

  const tagChips = tags
    .map((t) =>
      annotationForm(deleteAction(t.id), {}, `<button type="submit" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-polaris-100 text-polaris-800 hover:bg-polaris-200" title="Remove tag">#${escapeHtml(t.value ?? "")} <span class="text-polaris-400">&times;</span></button>`)
    )
    .join("");

  const tagAdder = `
      <details class="inline-block">
        <summary class="text-xs text-gray-400 hover:text-polaris-700 cursor-pointer select-none list-none">+ Tag</summary>
        <form method="POST" action="${addAction}" class="inline-flex items-center gap-1 mt-1">
          <input type="hidden" name="event_id" value="${e.id}">
          <input type="hidden" name="kind" value="tag">
          <input name="value" required placeholder="tag-name" class="w-28 border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-polaris-300">
          <button type="submit" class="px-2 py-0.5 bg-polaris-700 text-white text-xs font-medium rounded hover:bg-polaris-800">Add</button>
        </form>
      </details>`;

  const decisionControl = decision
    ? annotationForm(deleteAction(decision.id), {}, `<button type="submit" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 hover:bg-purple-200" title="Unmark decision">&#9873; Decision <span class="text-purple-400">&times;</span></button>`)
    : annotationForm(addAction, { event_id: e.id, kind: "decision", value: eventExcerpt(e) }, `<button type="submit" class="text-xs text-gray-400 hover:text-purple-700" title="Mark as decision">&#9873; Decision</button>`);

  return `
    <div class="flex flex-wrap items-center gap-2 mt-1 px-1">
      ${starControl}
      ${tagChips}
      ${tagAdder}
      ${decisionControl}
    </div>`;
}

export function renderTranscriptView(
  ctx: PageContext,
  project: string,
  session: string,
  events: TranscriptEvent[],
  nextCursor: string | null,
  before?: string,
  annotations: Annotation[] = []
): string {
  const base = `/sessions/${encodeURIComponent(project)}/${encodeURIComponent(session)}`;
  const items = [...events]
    .reverse()
    .map((e) => {
      const html = renderTranscriptItem(e);
      return html ? `<div>${html}${renderAnnotationControls(e, annotations, base, ctx.token)}</div>` : "";
    })
    .filter((html) => html !== "")
    .join("\n");

  // Session-level annotations (no event_id) render as badges under the header.
  const sessionBadges = annotations
    .filter((a) => a.event_id === null)
    .map((a) =>
      a.kind === "tag"
        ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-polaris-100 text-polaris-800">#${escapeHtml(a.value ?? "")}</span>`
        : a.kind === "decision"
          ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">&#9873; ${escapeHtml(a.value ?? "Decision")}</span>`
          : `<span class="text-xs text-amber-500">&#9733;</span>`
    )
    .join("");

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
        ${sessionBadges ? `<div class="flex flex-wrap items-center gap-2 mb-3">${sessionBadges}</div>` : ""}
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
  tag: string;
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
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input name="project" value="${escapeHtml(query.project)}" placeholder="Project" class="${inputClass}">
            <input name="sender" value="${escapeHtml(query.sender)}" placeholder="Sender (e.g. user:priya)" class="${inputClass}">
            <select name="source" class="bg-white ${inputClass}">${sourceOptions}</select>
            <input name="tag" value="${escapeHtml(query.tag)}" placeholder="Tag" class="${inputClass}">
          </div>
        </form>
      </div>
      ${resultsSection}
    </div>`;
}

// --- Decisions view ---
// Org-wide list of 'decision' annotations, each linking back to its transcript.

export function renderDecisionsView(ctx: PageContext, projectFilter: string, decisions: Annotation[] | null, error?: string): string {
  let listSection = "";
  if (error) {
    listSection = `<div class="bg-white border border-red-200 rounded-lg p-5 text-sm text-red-700">${escapeHtml(error)}</div>`;
  } else if (decisions !== null) {
    const items = decisions.map((d) => {
      const href = `/sessions/${encodeURIComponent(d.project)}/${encodeURIComponent(d.session)}?token=${ctx.token}`;
      return `
        <div class="bg-white border border-gray-200 rounded-lg p-4">
          <div class="flex items-baseline gap-2 text-xs text-gray-400">
            <span class="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">&#9873; Decision</span>
            ${d.participant_id ? `<span class="font-medium text-gray-700">${escapeHtml(d.participant_id)}</span>` : ""}
            <span class="font-mono">${escapeHtml(d.project)}/${escapeHtml(d.session)}</span>
            <span class="ml-auto">${new Date(d.created_at).toLocaleString()}</span>
          </div>
          <p class="mt-1.5 text-sm text-gray-700 whitespace-pre-wrap">${d.value ? escapeHtml(d.value) : '<span class="text-gray-400">No note</span>'}</p>
          <a href="${href}" class="mt-2 inline-block text-xs font-medium text-polaris-700 hover:text-polaris-800">View transcript</a>
        </div>`;
    }).join("");
    listSection = decisions.length
      ? `<div class="space-y-3">${items}</div>`
      : `<div class="bg-white border border-gray-200 rounded-lg p-5 text-sm text-gray-500">No decisions recorded yet. Mark transcript events as decisions to collect them here.</div>`;
  }

  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 pb-16 space-y-6">
      <div>
        ${sectionHeader("Decisions")}
        <form method="GET" action="/decisions" class="bg-white border border-gray-200 rounded-lg p-5 flex gap-2">
          <input type="hidden" name="token" value="${ctx.token}">
          <input name="project" value="${escapeHtml(projectFilter)}" placeholder="Filter by project" class="flex-1 ${formInputClass}">
          <button type="submit" class="px-4 py-2 bg-polaris-700 text-white text-sm font-medium rounded-lg hover:bg-polaris-800 transition">Filter</button>
        </form>
      </div>
      ${listSection}
    </div>`;
}

// --- Project settings view ---
// Visibility toggle ('org' = everyone, 'members' = restricted) and member management.

export interface ProjectMemberView {
  participant_id: string;
  role: string | null;
}

export function renderProjectSettingsView(ctx: PageContext, project: string, visibility: string, members: ProjectMemberView[], membersError?: string): string {
  const base = `/projects/${encodeURIComponent(project)}`;
  const isMembers = visibility === "members";

  const memberRows = members.map((m) => `
    <div class="px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <p class="text-sm font-mono text-gray-700">${escapeHtml(m.participant_id)}</p>
        ${m.role ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">${escapeHtml(m.role)}</span>` : ""}
      </div>
      <form method="POST" action="${base}/members/${encodeURIComponent(m.participant_id)}/delete?token=${ctx.token}">
        <button type="submit" class="text-xs font-medium text-red-600 hover:text-red-700">Remove</button>
      </form>
    </div>`).join("");

  return `
    ${nav(ctx.token, navOpts(ctx))}
    <div class="max-w-3xl mx-auto px-6 pt-12 pb-16 space-y-10">
      <div>
        ${sectionHeader("Project settings")}
        <div class="flex items-baseline justify-between mb-4">
          <h1 class="text-2xl font-bold text-gray-900">${escapeHtml(project)}</h1>
          <a href="/dashboard?token=${ctx.token}" class="text-xs font-medium text-polaris-700 hover:text-polaris-800">Back to dashboard</a>
        </div>
        <form method="POST" action="${base}/visibility?token=${ctx.token}" class="bg-white border border-gray-200 rounded-lg p-5">
          <p class="text-sm font-semibold text-gray-900">Visibility</p>
          <p class="text-sm text-gray-500 mt-1">Who can view this project's sessions and transcripts.</p>
          <div class="mt-3 space-y-2">
            <label class="flex items-center gap-2 text-sm text-gray-700">
              <input type="radio" name="visibility" value="org"${isMembers ? "" : " checked"}>
              Everyone in the organization
            </label>
            <label class="flex items-center gap-2 text-sm text-gray-700">
              <input type="radio" name="visibility" value="members"${isMembers ? " checked" : ""}>
              Members only
            </label>
          </div>
          <button type="submit" class="mt-4 px-4 py-2 bg-polaris-700 text-white text-sm font-medium rounded-lg hover:bg-polaris-800 transition">Save visibility</button>
        </form>
      </div>

      <div>
        ${sectionHeader("Members")}
        ${membersError ? `<div class="bg-white border border-red-200 rounded-lg p-5 text-sm text-red-700 mb-3">${escapeHtml(membersError)}</div>` : ""}
        <div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          ${memberRows || `<div class="px-4 py-3 text-sm text-gray-500">No members yet.${isMembers ? "" : " Membership only applies when visibility is set to members only."}</div>`}
        </div>
        <form method="POST" action="${base}/members?token=${ctx.token}" class="mt-3 bg-white border border-gray-200 rounded-lg p-5">
          <p class="text-sm font-semibold text-gray-900">Add member</p>
          <div class="mt-3 flex flex-col sm:flex-row gap-2">
            <input name="participant_id" required placeholder="user:priya" class="flex-1 ${formInputClass}">
            <input name="role" placeholder="Role (optional)" class="sm:w-40 ${formInputClass}">
            <button type="submit" class="px-4 py-2 bg-polaris-700 text-white text-sm font-medium rounded-lg hover:bg-polaris-800 transition">Add</button>
          </div>
        </form>
      </div>
    </div>`;
}
