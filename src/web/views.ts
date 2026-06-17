// --- View functions for dashboard states ---
// All views follow three consistent sections: Floor, Devices, Projects & Sessions.

import { nav, slackIcon, type NavOpts } from "./layout";
import type { SessionFixture, ProjectFixture, DeviceFixture } from "./fixtures";

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

function navOpts(ctx: ViewContext): NavOpts {
  return { userName: ctx.userName, orgName: ctx.orgName, email: ctx.email, plan: ctx.plan, banner: bannerForCtx(ctx) };
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

// --- Banner helpers ---

function bannerForCtx(ctx: ViewContext): { message: string; style: "info" | "success" | "warning" } | undefined {
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
          ${projects.map((p) => renderProjectCard(p, ctx.userName)).join("")}
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

function renderProjectCard(project: ProjectFixture, userName: string): string {
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
          return `
            <div class="px-4 py-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-2 h-2 rounded-full bg-green-500"></div>
                <p class="text-sm text-gray-700">${s.name}</p>
                ${roleBadge}
              </div>
              <div class="flex items-center gap-3">
                ${driverLabel}
                ${promptLabel}
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
