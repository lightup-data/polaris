// --- Seed data for dev, test, and /preview ---

export interface DeviceFixture {
  name: string;
  lastSeen: string;
  os: string;
  activeSession?: string;
}

export interface SessionFixture {
  name: string;
  project: string;
  driver: string;
  role: "driver" | "advisor";
  description: string;
  participants: Array<{ id: string; role: "driver" | "advisor" }>;
  eventCount: number;
  connectedSince: string;
}

export interface ProjectFixture {
  name: string;
  sessions: SessionFixture[];
  slackChannel: string;
}

export const mockUser = {
  name: "Manu Bansal",
  email: "manu@lightup.ai",
  participant_id: "user:manu",
  org_id: "org-lightup",
};

export const mockOrg = {
  id: "org-lightup",
  name: "Lightup",
  domain: "lightup.ai",
  slack_team_id: "T0123SLACK",
  slack_bot_token: null,
};

export const mockOrgNoSlack = {
  ...mockOrg,
  slack_team_id: null,
};

export const mockProjects: ProjectFixture[] = [
  {
    name: "polaris",
    slackChannel: "#polaris",
    sessions: [
      {
        name: "auth",
        project: "polaris",
        driver: "user:manu",
        role: "driver",
        description: "Google SSO + JWT auth",
        participants: [
          { id: "user:manu", role: "driver" },
          { id: "agent:security-reviewer", role: "advisor" },
        ],
        eventCount: 42,
        connectedSince: "2026-06-08T10:00:00.000Z",
      },
      {
        name: "slack-bridge",
        project: "polaris",
        driver: "user:krishna",
        role: "advisor",
        description: "Slack floor integration",
        participants: [
          { id: "user:krishna", role: "driver" },
          { id: "user:manu", role: "advisor" },
          { id: "agent:test-writer", role: "advisor" },
        ],
        eventCount: 18,
        connectedSince: "2026-06-08T11:30:00.000Z",
      },
    ],
  },
  {
    name: "data-pipeline",
    slackChannel: "#data-pipeline",
    sessions: [
      {
        name: "ingestion",
        project: "data-pipeline",
        driver: "agent:dq-checker",
        role: "advisor",
        description: "S3-to-Snowflake rewrite",
        participants: [
          { id: "agent:dq-checker", role: "driver" },
          { id: "user:manu", role: "advisor" },
        ],
        eventCount: 7,
        connectedSince: "2026-06-08T09:15:00.000Z",
      },
    ],
  },
];

export const mockActiveSessions: SessionFixture[] = mockProjects
  .flatMap((p) => p.sessions)
  .filter((s) => s.participants.some((p) => p.id === mockUser.participant_id));

export const mockEmptySessions: SessionFixture[] = [];

export const mockDevices: DeviceFixture[] = [
  {
    name: "Manu's MacBook Pro",
    lastSeen: "2026-06-08T18:42:00.000Z",
    os: "macOS",
    activeSession: "polaris/auth",
  },
  {
    name: "Manu's iMac",
    lastSeen: "2026-06-08T16:10:00.000Z",
    os: "macOS",
    activeSession: undefined,
  },
];
