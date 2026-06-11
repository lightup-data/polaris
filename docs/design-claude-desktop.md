# Design: Claude Desktop Support

## Current State

Polaris is built for Claude Code (CLI and desktop app), which provides:
- Hook system for automatic event capture
- Skills/slash commands for `/polaris join`
- Status line for connection indicator
- MCP server support for tools

Claude Desktop supports MCP servers but lacks hooks, skills, and status line.

## What Works Without Changes

- **MCP tools**: polaris_connect, polaris_disconnect, polaris_status, polaris_reply, polaris_context, polaris_rename
- **Advisor injection**: messages from Slack reach the agent via the MCP channel capability
- **Agent collaboration**: the agent can join projects, read sibling sessions, and send replies

## What's Missing

### 1. Automatic Event Capture (critical gap)

Claude Code captures every interaction via hooks:
- `UserPromptSubmit` → human typed a prompt
- `Stop` → agent responded
- `PreToolUse` / `PostToolUse` → agent used a tool

Claude Desktop has no hook system. Without it, the floor is blind to what's happening in a Claude Desktop session. Slack shows nothing. The dashboard shows no activity.

#### Options for event capture

**A. Agent self-reporting via MCP tool**

Add a `polaris_log` tool. Instruct the agent (via MCP server instructions) to call it after every response:

```
After each response, call polaris_log with a brief summary of what you did.
```

Pros: Works today, no platform changes needed.
Cons: Lossy (agent may forget), adds latency, clutters the tool call log, relies on instruction following.

**B. MCP sampling / conversation observation**

The MCP spec has a `sampling` capability where the server can request to see conversation messages. If Claude Desktop supports this, the MCP server could observe the conversation passively.

Pros: Automatic, no agent cooperation needed.
Cons: May not be supported, privacy implications, spec is experimental.

**C. Claude Desktop adds hook support**

Anthropic adds a hook system to Claude Desktop, similar to Claude Code.

Pros: Full parity, same code works everywhere.
Cons: Depends on Anthropic's roadmap, not in our control.

**D. Accept the gap**

Claude Desktop users get tools (join, reply, context) but not automatic capture. Their sessions appear on the floor only when they explicitly send a reply or when advisors inject messages.

Pros: No work needed, honest about limitations.
Cons: Half the value prop is missing — teammates can't see what's happening.

#### Recommendation

Start with **D** (accept the gap) + **A** (agent self-reporting) as an opt-in enhancement. Document the limitation clearly. Push for **C** as a feature request to Anthropic.

### 2. MCP Config Path

| Platform | Claude Code | Claude Desktop |
|----------|-------------|----------------|
| macOS | `~/.claude/.mcp.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%USERPROFILE%\.claude\.mcp.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.claude/.mcp.json` | `~/.config/Claude/claude_desktop_config.json` |

The `polaris install` command needs to detect which apps are installed and write to both config files.

### 3. Skills / Slash Commands

Claude Desktop doesn't have skills. The user can't type `/polaris join`. Instead:
- The MCP server's `instructions` field tells the agent about available tools
- The user says "connect to polaris project X" and the agent calls `polaris_connect`
- Less discoverable but functional

### 4. Status Line

No equivalent in Claude Desktop. The user can ask "are we connected to polaris?" and the agent calls `polaris_status`. Not ideal but workable.

## Implementation Plan (when ready)

### Phase 1: Basic support
- `polaris install` writes MCP config to both Claude Code and Claude Desktop paths
- Document that event capture is limited
- MCP server instructions are detailed enough for the agent to self-serve

### Phase 2: Agent self-reporting
- Add `polaris_log` tool to MCP server
- MCP server instructions tell the agent to log after each response
- Events appear on the floor with `agent:claude-desktop` identity
- Accept that human prompts won't be captured (only agent responses)

### Phase 3: Full parity (depends on platform)
- If Claude Desktop adds hooks → same capture as Claude Code
- If MCP sampling lands → passive observation of conversation
- Either way, the architecture is ready — the daemon handles everything

## Open Questions

1. Does Claude Desktop respect MCP server `instructions` reliably enough for self-reporting?
2. Is `sampling` capability available or planned for Claude Desktop?
3. Should `polaris install` auto-detect installed apps or require `--desktop` flag?
4. How do we handle the case where both Claude Code and Claude Desktop are installed on the same machine? Same daemon, same MCP server, different config files — should work.
