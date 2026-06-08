// --- View functions for dashboard states ---
// All views follow three consistent sections: Floor, Devices, Projects & Sessions.

import { nav, slackIcon, type NavOpts } from "./layout";
import type { SessionFixture, ProjectFixture, DeviceFixture } from "./fixtures";

interface ViewContext {
  token: string;
  userName: string;
  orgName: string;
  email: string;
  slackConnected: boolean;
  cliInstalled: boolean;
  hasConnectedSession: boolean;
}

function navOpts(ctx: ViewContext): NavOpts {
  return { userName: ctx.userName, orgName: ctx.orgName, email: ctx.email };
}

// --- Copyable code block ---

function copyBlock(text: string): string {
  const id = `copy-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div class="mt-3 relative">
      <code id="${id}" class="block bg-gray-50 border border-gray-200 rounded px-3 py-2 pr-10 text-xs font-mono select-all">${text}</code>
      <button onclick="navigator.clipboard.writeText(document.getElementById('${id}').textContent);this.innerHTML='<svg class=\\'w-3.5 h-3.5 text-green-500\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'2\\' d=\\'M5 13l4 4L19 7\\'/></svg>';setTimeout(()=>this.innerHTML='<svg class=\\'w-3.5 h-3.5\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'2\\' d=\\'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z\\'/></svg>',1500)"
        class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition rounded" title="Copy">
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
    return `
      <div>
        ${sectionHeader("Floor")}
        <div class="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
            ${slackIcon.replace('class="w-4 h-4"', 'class="w-4 h-4 text-white"')}
          </div>
          <p class="text-sm font-medium text-gray-900">Slack</p>
          ${statusBadge("Live", true)}
        </div>
      </div>`;
  }

  if (ctx.slackConnected) {
    return `
      <div>
        ${sectionHeader("Floor")}
        <div class="bg-white border border-gray-200 rounded-lg p-5">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-[#4A154B] flex items-center justify-center shrink-0">
              ${slackIcon.replace('class="w-4 h-4"', 'class="w-5 h-5 text-white"')}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <p class="text-sm font-semibold text-gray-900">Slack</p>
                ${statusBadge("Connected", true)}
              </div>
              <p class="text-sm text-gray-500 mt-0.5">Workspace linked. Channels are auto-created for your projects.</p>
            </div>
          </div>
        </div>
      </div>`;
  }

  return sectionWrap(state, `
    <div>
      ${sectionHeader("Floor")}
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-amber-200"} rounded-lg p-5">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <p class="text-sm font-semibold text-gray-900">Slack</p>
              ${statusBadge("Not connected", false)}
            </div>
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
        ${sectionHeader("Devices")}
        <div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          ${devices.map((d) => renderDeviceRow(d)).join("")}
        </div>
      </div>`;
  }

  // Setup state — no devices yet
  return sectionWrap(state, `
    <div>
      ${sectionHeader("Devices")}
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-gray-200"} rounded-lg p-5">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold text-gray-900">Install the CLI on your first device</p>
          ${ctx.cliInstalled ? statusBadge("Installed", true) : statusBadge("Not installed", false)}
        </div>
        <p class="text-sm text-gray-500 mt-1">${ctx.cliInstalled
          ? "Polaris is set up. Run the same command on other machines to add them."
          : "Run this in your terminal. Repeat on each machine you work from."}</p>
        ${ctx.cliInstalled
          ? ""
          : copyBlock("npx @lightup/polaris login")}
      </div>
    </div>`);
}

function renderDeviceRow(device: DeviceFixture): string {
  const isOnline = device.activeSession;
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
        ${isOnline
          ? `<p class="text-xs font-medium text-gray-700">${device.activeSession}</p>
             <p class="text-xs text-gray-400">Active now</p>`
          : `<p class="text-xs text-gray-400">Last seen ${new Date(device.lastSeen).toLocaleDateString()}</p>`}
      </div>
    </div>`;
}

// --- Projects & Sessions section ---

function renderProjectsSessionsSection(ctx: ViewContext, sessions: SessionFixture[], projects: ProjectFixture[], state: StepState = "done"): string {
  if (sessions.length > 0) {
    return `
      <div>
        ${sectionHeader("Projects & Sessions")}
        <div class="space-y-3">
          ${sessions.map((s) => renderSessionCard(s, ctx.userName)).join("")}
        </div>
        ${projects.length > 0 ? `
        <div class="mt-4 space-y-3">
          ${projects.map((p) => renderProjectCard(p)).join("")}
        </div>` : ""}
      </div>`;
  }

  // Setup state — no sessions yet
  return sectionWrap(state, `
    <div>
      ${sectionHeader("Projects & Sessions")}
      <div class="bg-white border ${state === "active" ? cardClass("active") : "border-gray-200"} rounded-lg p-5">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold text-gray-900">Connect your first session</p>
          ${ctx.hasConnectedSession ? statusBadge("Connected", true) : statusBadge("Waiting", false)}
        </div>
        <p class="text-sm text-gray-500 mt-1">${ctx.hasConnectedSession
          ? "You've connected a session. You're ready to collaborate."
          : "Inside your AI agent (Claude Code, Cursor, etc.), run:"}</p>
        ${ctx.hasConnectedSession
          ? ""
          : copyBlock("/polaris join my-project my-session")}
      </div>
    </div>`);
}

function renderSessionCard(session: SessionFixture, userName: string): string {
  const isDriver = session.participants.some((p) => p.id === `user:${userName.toLowerCase().replace(/\s+/g, ".")}` && p.role === "driver");
  const roleBadge = isDriver
    ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-polaris-100 text-polaris-800">Driver</span>'
    : '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Advisor</span>';

  const otherParticipants = session.participants
    .filter((p) => p.id !== `user:${userName.toLowerCase().replace(/\s+/g, ".")}`)
    .map((p) => `<span class="text-xs text-gray-500">${p.id}</span>`)
    .join(", ");

  return `
    <div class="bg-white border border-gray-200 rounded-lg p-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full bg-green-500"></div>
          <p class="text-sm font-semibold text-gray-900">${session.project}/${session.name}</p>
          ${roleBadge}
        </div>
        <span class="text-xs text-gray-400">${session.eventCount} events</span>
      </div>
      <p class="text-sm text-gray-500 mt-1">${session.description}</p>
      <div class="mt-2 flex items-center gap-1">
        <span class="text-xs text-gray-400">with</span>
        ${otherParticipants}
      </div>
    </div>`;
}

function renderProjectCard(project: ProjectFixture): string {
  const activeSessions = project.sessions.length;
  const drivers = project.sessions.map((s) => s.driver).filter((d, i, a) => a.indexOf(d) === i);

  return `
    <div class="bg-white border border-gray-200 rounded-lg p-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold text-gray-900">${project.name}</p>
          <span class="text-xs text-gray-400">${project.slackChannel}</span>
        </div>
        <span class="text-xs text-gray-400">${activeSessions} session${activeSessions !== 1 ? "s" : ""}</span>
      </div>
      <div class="mt-2 flex items-center gap-2 flex-wrap">
        ${drivers.map((d) => `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-50 text-gray-600">${d}</span>`).join("")}
      </div>
    </div>`;
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
    </div>`;
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
    </div>`;
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
