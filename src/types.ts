import { z } from "zod";

// --- Participant Identity ---

export const ParticipantId = z
  .string()
  .regex(
    /^(user|agent|slack):[a-z0-9][a-z0-9._-]*$/,
    "Must be user:<name>, agent:<name>, or slack:<name> (lowercase alphanumeric, dots, hyphens, underscores)"
  );

export type ParticipantId = z.infer<typeof ParticipantId>;

// --- Hook Event Payloads ---

const HookCommon = z.object({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
});

export const UserPromptSubmitPayload = HookCommon.extend({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
});

export const StopPayload = HookCommon.extend({
  hook_event_name: z.literal("Stop"),
  stop_response: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  raw_turn: z.array(z.unknown()).optional(),
});

export const PreToolUsePayload = HookCommon.extend({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()),
});

export const PostToolUsePayload = HookCommon.extend({
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()),
  tool_result: z.unknown(),
});

export const HookPayload = z.discriminatedUnion("hook_event_name", [
  UserPromptSubmitPayload,
  StopPayload,
  PreToolUsePayload,
  PostToolUsePayload,
]);

export type HookPayload = z.infer<typeof HookPayload>;

// --- Inject & Reply Messages ---

export const InjectMessage = z.object({
  type: z.literal("inject"),
  content: z.string(),
  sender: ParticipantId,
  target: z.string().min(1, "target session is required"),
});

export type InjectMessage = z.infer<typeof InjectMessage>;

export const ReplyMessage = z.object({
  type: z.literal("reply"),
  content: z.string(),
  sender: ParticipantId,
  in_reply_to: z.string().optional(),
});

export type ReplyMessage = z.infer<typeof ReplyMessage>;

// --- Event Envelope ---

export const EventSource = z.enum(["hook", "inject", "reply"]);
export type EventSource = z.infer<typeof EventSource>;

export const PolarisEvent = z.object({
  id: z.string().uuid(),
  project: z.string().min(1),
  session: z.string().min(1),
  timestamp: z.string().datetime(),
  source: EventSource,
  sender: ParticipantId,
  payload: z.union([HookPayload, InjectMessage, ReplyMessage]),
});

export type PolarisEvent = z.infer<typeof PolarisEvent>;

// --- Project & Session Models ---

export const Project = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slack_channel_id: z.string().nullable().optional(),
  slack_channel_name: z.string().nullable().optional(),
  created_at: z.string().datetime(),
});

export type Project = z.infer<typeof Project>;

export const Session = z.object({
  name: z.string().min(1),
  project: z.string().min(1),
  driver: ParticipantId.nullable(),
  created_at: z.string().datetime(),
});

export type Session = z.infer<typeof Session>;
