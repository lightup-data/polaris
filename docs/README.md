# Polaris

Multiplayer collaboration for AI agents and humans. Capture, share, and coordinate across agent sessions — with humans and AI agents working together on any kind of work. Model-agnostic: works with any AI agent (e.g., Claude Code, Cursor, custom agents).

## What Polaris Does

Polaris connects AI agent sessions to a shared cloud service, enabling teams to collaborate in real time on any kind of work — software development, data analysis, event planning, and more.

- **Capture** every interaction in an agent session — user prompts, agent responses, tool calls — and broadcast it to your team
- **Inject** context from teammates or agents into a live agent session so the agent can incorporate it immediately
- **Pool context** across multiple concurrent workstreams so everyone benefits from the full picture
- **Hand off** work from one person to another with full context preserved

## Getting Started

### 1. Admin signs up the org (once)

Visit [polaris.dev](https://polaris.dev) and sign up with Google SSO. This creates your organization. From the dashboard:

- **Connect your Slack workspace** — one-click OAuth, enables the floor for all projects
- **Invite your team** — by email, or allow auto-join by email domain

### 2. Each team member sets up their machine (once)

```sh
npx @lightup/polaris login
```

This opens your browser for Google SSO, then automatically installs everything:
- Local daemon for session routing
- AI agent integration (MCP server, hooks, status line)
- The `/polaris` command

One command. Done.

### 3. Connect to a session (each time)

Inside any AI agent (Claude Code, Cursor, etc.):

```
/polaris join my-project feature-1
```

Your agent session is now connected. Everything you do is captured and broadcast to the project's floor. Advisors can inject context into your session in real time.

## Core Concepts

### Projects

A project is the top-level workspace for collaboration, scoped to your organization. It groups related sessions together and pools context across them. Each project has a **floor** — a shared space where all activity is broadcast and anyone can participate. The floor is backed by a messaging platform (Slack, WhatsApp, Discord, or any supported bridge).

Create a project for any coordinated effort — a feature build, a sprint, an incident response, a trip with friends.

### Sessions

A session is a single workstream within a project — one person or agent working on one thing via an AI agent. A project can have many sessions running concurrently.

Examples: `auth-middleware`, `db-schema`, `tests`, `docs`.

### Drivers

Each session has one **driver** — the person or agent actively working via an AI agent. The driver's interactions are captured and broadcast. Only one driver per session at a time, but a project can have multiple sessions with different drivers working in parallel.

### Advisors

Advisors contribute context to a session without being the driver. They post on the project's floor, targeting a specific session. Their input is injected directly into that session — the agent sees it and can incorporate it immediately.

Anyone can advise any session at any time. Multiple advisors can contribute simultaneously.

### The Floor

Each project has a floor — a shared space backed by a messaging platform (Slack, WhatsApp, Discord, or any platform with a Polaris bridge). The floor shows:

- An interleaved, attributed log of all sessions' activity
- Who said what, in which session (human and agent)
- Handoff transitions
- Advisory messages and their targets

Advisors participate directly on the floor. The floor is the complete, living record of the project.

### Participants

Every participant has an identity, derived automatically from SSO:

| Type | Examples | Description |
|------|----------|-------------|
| `user:` | `user:manu`, `user:krishna` | Human participants (identity from Google SSO) |
| `agent:` | `agent:test-writer`, `agent:security-reviewer` | AI agent participants |
| `slack:` | `slack:someone` | Slack-only participants without a Polaris account |

Agents are first-class. They can be drivers or advisors, same as humans. The system treats them identically — the only difference is how they're labeled in the log.

**Slack identity mapping is automatic** — Polaris matches your Google SSO email to your Slack profile. When your work appears on the floor, it shows your Slack avatar and display name.

### Handoff

The driver role on a session can transfer from one person to another:

1. The current driver releases the session
2. The new driver claims it and connects their agent
3. The new driver's session is seeded with context from the project history
4. The floor shows the transition

The log is continuous across handoffs — one unbroken narrative of how the work was done.

### Cross-Session Context

Drivers can query what's happening in other sessions within the same project. This is pull-based (on demand), not push-based, so drivers aren't interrupted by sibling activity.

Use this to coordinate — check what a teammate has built before building something that depends on it.

## The `/polaris` Command

Everything happens through one slash command inside your AI agent:

| Command | What it does |
|---------|-------------|
| `/polaris join <project> <session>` | Connect to a session (creates it if new) |
| `/polaris` | Show connection status |
| `/polaris disconnect` | Disconnect from current session |

The status line at the bottom of your agent always shows your connection state:

```
polaris: my-project/feature-1 (user:manu) ● connected
```

## Features

### Session Capture and Broadcast

Everything that happens in an agent session is captured and broadcast:

- User prompts
- Agent responses
- Tool calls and results (collapsed on the floor to reduce noise)

The broadcast goes to the project's floor and is persisted as the permanent record.

### Context Injection

Advisors can inject context into any session by posting on the project's floor and targeting the session. The driver's agent sees the advisory message as it arrives.

Every injection must specify a target session — no untargeted broadcasts.

### Context Pooling

All events across all sessions in a project are stored together. This shared context means:

- Advisors' messages reach the target driver in real time
- Any driver can pull context from sibling sessions on demand (e.g., "what has Krishna done on the database schema?")
- When someone takes over a session or starts a new one, they can be seeded with the full project history

Sibling session activity is available on-demand, not auto-injected, to avoid noise.

## Examples

### Software Development: Web App

A team building a web app, with two human developers and two AI agents:

```
Project: webapp
├── session auth        driver: user:manu              auth middleware
├── session db-schema   driver: user:krishna            database schema
├── session tests       driver: agent:test-writer       test suite
│
├── advisor: agent:security-reviewer
└── advisor: user:priya (via Slack)
```

The floor (Slack `#webapp`) shows:

```
[user:manu/auth → agent]             "Let's implement the auth middleware"
[agent → user:manu/auth]             "I'll create src/middleware/auth.ts..."
[user:krishna/db-schema → agent]     "Set up the database schema for users"
[agent → user:krishna/db-schema]     "Creating migrations/001_users.sql..."
[user:priya → db-schema]             "Remember we need GDPR compliance on the users table"
[agent → user:krishna/db-schema]     "Good point from Priya. Adding data retention fields..."
[agent:security-reviewer → auth]     "This auth endpoint needs rate limiting"
[agent → user:manu/auth]             "Adding rate limiting middleware..."
[agent:test-writer/tests → agent]    "Writing integration tests for auth middleware"
[agent → agent:test-writer/tests]    "Created tests/auth.test.ts..."
```

Manu finishes auth, hands off db-schema to himself to continue Krishna's work. The log continues seamlessly.

### Data Engineering: Pipeline Migration

A data engineering team migrating a legacy Airflow pipeline to a new orchestrator, with a data quality agent watching for issues:

```
Project: pipeline-migration
├── session ingestion     driver: user:sara              rewrite ingestion DAGs
├── session transforms    driver: user:raj               port dbt transforms
├── session validation    driver: agent:dq-checker       data quality checks
│
├── advisor: agent:schema-drift-monitor
├── advisor: user:lee (data platform lead, via Slack)
```

The floor (Slack `#pipeline-migration`) shows:

```
[user:sara/ingestion → agent]             "Rewrite the S3-to-Snowflake ingestion DAG for the new orchestrator"
[agent → user:sara/ingestion]             "I'll create pipelines/ingest_s3_snowflake.py using the new SDK..."
[user:raj/transforms → agent]             "Port the customer_ltv dbt model and its upstream dependencies"
[agent → user:raj/transforms]             "Mapping the dependency graph: customer_ltv depends on orders, payments..."
[agent:schema-drift-monitor → transforms] "Column 'payment_method' was renamed to 'pay_type' in source system as of last night's sync"
[agent → user:raj/transforms]             "Updating the dbt model to reference 'pay_type' instead..."
[user:lee → ingestion]                    "Use the v2 Snowflake connector — v1 doesn't support the new auth"
[agent → user:sara/ingestion]             "Switching to v2 connector and updating credentials config..."
[agent:dq-checker/validation → agent]     "Running row count and null checks on migrated tables"
[agent → agent:dq-checker/validation]     "3 tables passed. orders_raw has 2.3% null rate on customer_id, up from 0.1%"
[agent:dq-checker → ingestion]            "orders_raw customer_id null rate jumped to 2.3% — likely a source schema change"
[agent → user:sara/ingestion]             "Investigating — adding null handling for customer_id in the ingestion pipeline..."
```

Sara finishes ingestion, Raj finishes transforms. The dq-checker agent continues running validation against production data. Lee reviews the full log on the floor to verify the migration is complete.

### Marketing: Email Campaign Launch

A marketing team building and launching a segmented email campaign, with AI agents handling personalization and compliance:

```
Project: spring-campaign
├── session segments      driver: user:jess              audience segmentation queries
├── session templates     driver: user:marco             email HTML/copy
├── session personalize   driver: agent:content-writer   variant generation
│
├── advisor: agent:compliance-checker
├── advisor: user:dana (brand director, via Slack)
```

The floor (Slack `#spring-campaign`) shows:

```
[user:jess/segments → agent]               "Build segments for the spring campaign: churned-30d, active-high-ltv, new-trial"
[agent → user:jess/segments]               "Creating SQL queries for each segment against the warehouse..."
[user:marco/templates → agent]             "Create the base email template with our new brand guidelines"
[agent → user:marco/templates]             "Building responsive HTML template with the updated color palette..."
[user:dana → templates]                    "Use the shorter subject line format we tested last quarter — under 40 chars"
[agent → user:marco/templates]             "Constraining subject lines to under 40 characters..."
[agent:compliance-checker → templates]     "CAN-SPAM: unsubscribe link must be in the first scroll. Also add physical mailing address."
[agent → user:marco/templates]             "Moving unsubscribe link above the fold and adding mailing address to footer..."
[user:jess/segments → agent]               "What does the template look like so far?"
[agent → user:jess/segments]               "Marco's template has responsive layout, short subject lines, CAN-SPAM compliant footer..."
[agent:content-writer/personalize → agent] "Generate 3 subject line variants per segment based on the template and segment profiles"
[agent → agent:content-writer/personalize] "Churned-30d: 'We miss you — 20% off this week'... Active-high-ltv: 'Early access: spring collection'..."
[agent:compliance-checker → personalize]   "Variant 2 for new-trial uses 'FREE' in all caps — likely to trigger spam filters"
[agent → agent:content-writer/personalize] "Revising variant 2 to avoid spam trigger words..."
[user:marco/templates → agent]             "Pull in the final variants from the personalize session"
[agent → user:marco/templates]             "Integrating 9 approved variants into the template with merge tags..."
```

Jess hands off segments to the deployment team. Marco finalizes templates with the personalized variants. Dana reviews the full log in `#spring-campaign` to approve before send.

### Data Analytics: Quarterly Business Review

A VP of Sales asks a question that kicks off an analysis workflow across a human analyst, a data agent, and domain experts — all collaborating on the floor:

```
Project: q2-revenue-deep-dive
├── session exploration   driver: agent:data-analyst     initial data pull and exploration
├── session modeling      driver: user:nina              regression modeling and forecasting
│
├── advisor: user:tom (VP Sales — the question-asker)
├── advisor: user:finance-alex (FP&A, via Slack)
├── advisor: agent:chart-builder
```

The floor (Slack `#q2-revenue-deep-dive`) shows:

```
[user:tom → exploration]                      "Why did APAC revenue drop 15% in Q2? Break it down by segment and product line"
[agent:data-analyst/exploration → agent]      "Pulling Q2 APAC revenue by segment and product line from the warehouse..."
[agent → agent:data-analyst/exploration]      "Query complete. Enterprise segment is flat. The drop is concentrated in mid-market, specifically the Pro tier — down 34%"
[agent:data-analyst/exploration → agent]      "Drill into mid-market Pro: break down by new vs renewal, and pull churn timing"
[agent → agent:data-analyst/exploration]      "Renewal revenue is stable. The drop is entirely new bookings — pipeline gen fell off in April"
[user:tom → exploration]                      "Was that the month we restructured the APAC SDR team?"
[agent → agent:data-analyst/exploration]      "Checking timeline — yes, APAC SDR restructure was April 3rd. New opp creation dropped 40% in April, partially recovered in May"
[user:finance-alex → exploration]             "Pull the SDR headcount and ramp data — we had 3 reps in ramp during April, that's probably the gap"
[agent → agent:data-analyst/exploration]      "Confirmed: 3 of 8 APAC SDRs were in ramp (< 60 days). Fully ramped rep pipeline was actually up 5%"
[agent:data-analyst/exploration → agent]      "Root cause identified. Summarize findings for the modeling session"
[agent → agent:data-analyst/exploration]      "Summary ready: Q2 APAC revenue drop driven by new bookings shortfall in mid-market Pro, caused by SDR ramp gap from April restructure"
[user:nina/modeling → agent]                  "Pull the exploration findings and build a forecast — when does APAC recover if ramp completes on schedule?"
[agent → user:nina/modeling]                  "Fetching exploration context... Based on current ramp curves, full SDR productivity by late July. Modeling recovery..."
[agent:chart-builder → modeling]              "Here's the revenue recovery projection chart with confidence intervals for Tom's deck"
[agent → user:nina/modeling]                  "Incorporating chart. Adding scenario analysis: on-track ramp vs accelerated hiring..."
[user:tom → modeling]                         "Add a scenario where we backfill one more rep in July"
[agent → user:nina/modeling]                  "Adding backfill scenario — projects recovery 3 weeks earlier, +$180K in Q3 net new"
[user:finance-alex → modeling]                "That $180K assumes the same win rate. APAC mid-market win rate has been declining — use the trailing 3-month rate"
[agent → user:nina/modeling]                  "Adjusting win rate to trailing 3-month (18% vs 23%). Revised impact: +$140K in Q3"
```

Tom gets his answer — and a data-backed recommendation — without writing a query or opening a notebook. Nina produces the final model. The entire analytical thread is preserved in `#q2-revenue-deep-dive` for the QBR deck, audit trail, and future reference.

### Event Planning: Company Annual Kickoff

An event lead planning a 200-person, 3-day offsite — with AI agents handling research and drafting while stakeholders gate decisions from the floor:

```
Project: annual-kickoff-2026
├── session logistics     driver: user:rachel              venue, catering, travel
├── session agenda        driver: user:mike                schedule, speakers, workshops
├── session comms         driver: agent:content-drafter    invites, itinerary, speaker briefs
│
├── advisor: user:diana (CFO — budget authority, via Slack)
├── advisor: user:jay (IT — AV/tech setup, via Slack)
├── advisor: agent:venue-scout
```

The floor (Slack `#annual-kickoff-2026`) shows:

```
[user:rachel/logistics → agent]             "Find venues in Austin for 200 people, 3 days in September, budget $150K all-in"
[agent → user:rachel/logistics]             "Searching... 4 options shortlisted with pricing and availability"
[agent:venue-scout → logistics]             "Option 2 (Lakeway Resort) has a noise ordinance after 9pm — won't work for the evening events"
[agent → user:rachel/logistics]             "Dropping option 2. Top pick is now Line Hotel — $128K, available Sep 15-17"
[user:diana → logistics]                    "That $128K — does it include AV? Last year we got hit with $20K in AV add-ons"
[agent → user:rachel/logistics]             "Checking... AV is $8K extra at Line Hotel. Total $136K, under budget"
[user:mike/agenda → agent]                  "Draft a 3-day agenda: day 1 strategy, day 2 team workshops, day 3 hackathon + closing"
[agent → user:mike/agenda]                  "Here's the draft agenda with session blocks and break times..."
[user:jay → agenda]                         "Workshop rooms need breakout Zoom for remote attendees — max 6 concurrent streams"
[agent → user:mike/agenda]                  "Noted. Allocating workshops to 6 tracks max, adding Zoom setup requirements..."
[agent:content-drafter/comms → agent]       "Draft the save-the-date email based on logistics and agenda progress"
[agent → agent:content-drafter/comms]       "Fetching context from logistics and agenda... Draft ready: 'Annual Kickoff — Sep 15-17, Austin'"
[user:rachel/logistics → agent]             "What has Mike finalized on the agenda?"
[agent → user:rachel/logistics]             "Day 1: CEO keynote + strategy sessions. Day 2: 6 workshop tracks. Day 3: hackathon + awards dinner"
[user:diana → comms]                        "Don't send the save-the-date until I approve the venue contract"
[agent → agent:content-drafter/comms]       "Holding send. Marking draft as pending finance approval..."
```

Rachel handles logistics, Mike shapes the agenda, the content agent drafts communications pulling context from both. Diana gates spending from the floor without touching any tool. Jay flags technical requirements. The full planning trail lives on the floor — no code involved, just planning, decisions, and coordination.

### Personal: Trip Planning with Friends

A group of friends planning a week-long trip to Japan, with the floor on WhatsApp:

```
Project: japan-oct-2026
├── session flights      driver: user:alex              finding and booking flights
├── session stays        driver: user:sam               hotels, ryokans, Airbnbs
├── session itinerary    driver: agent:trip-planner      day-by-day plan
│
├── advisor: user:jordan (foodie — restaurant picks, via WhatsApp)
├── advisor: user:riley (been to Japan twice, via WhatsApp)
├── advisor: agent:budget-tracker
```

The floor (WhatsApp group `Japan Oct 2026`) shows:

```
[user:alex/flights → agent]                "Find round-trip flights SFO→Tokyo for 4 people, Oct 10-18, under $900/person"
[agent → user:alex/flights]                "Best options: ANA direct $870, JAL direct $920, United 1-stop $680"
[user:riley → flights]                     "Do ANA — the United 1-stop goes through Taipei and the layover is brutal"
[agent → user:alex/flights]                "Noted. ANA direct, $870/person, $3,480 total. Arrives Haneda 3pm local"
[agent:budget-tracker → flights]           "Running total: $3,480 of $8,000 group budget spent. $4,520 remaining for stays + activities"
[user:sam/stays → agent]                   "Find places for 4 in Tokyo (3 nights), Kyoto (2 nights), Osaka (2 nights)"
[agent → user:sam/stays]                   "Tokyo: Shinjuku apartment $180/night. Kyoto: traditional ryokan $220/night. Osaka: Dotonbori hotel $140/night"
[user:riley → stays]                       "Do the ryokan in Kyoto, 100%. Book one with a private onsen if you can"
[agent → user:sam/stays]                   "Found one with private onsen — $260/night. $40 more but it's the highlight of the trip"
[user:jordan → stays]                      "For Osaka, stay near Shinsekai not Dotonbori — way better street food and less touristy"
[agent → user:sam/stays]                   "Switching to Shinsekai area. Found a spot 5 min walk from Tsutenkaku — $130/night"
[agent:budget-tracker → stays]             "Stays total: $1,640. Running total: $5,120. $2,880 left for activities and food"
[agent:trip-planner/itinerary → agent]     "Build day-by-day itinerary pulling from flights and stays context"
[agent → agent:trip-planner/itinerary]     "Fetching context... Day 1: Arrive Haneda 3pm, train to Shinjuku, dinner in Golden Gai..."
[user:jordan → itinerary]                  "Day 2 evening: book Tsuta for ramen (Michelin star, need reservation) and hit up Omoide Yokocho after"
[agent → agent:trip-planner/itinerary]     "Adding Tsuta reservation to Day 2, Omoide Yokocho for late-night..."
[user:alex/flights → agent]                "What's the itinerary looking like so far?"
[agent → user:alex/flights]                "7 days planned: 3 Tokyo, 2 Kyoto, 2 Osaka. Highlights: ryokan with private onsen, Tsuta ramen, Fushimi Inari sunrise..."
[user:riley → itinerary]                   "Do Fushimi Inari at 5am, not during the day. Trust me, no crowds and it's magical"
[agent → agent:trip-planner/itinerary]     "Moving Fushimi Inari to 5am slot on Day 4..."
```

Everyone contributes what they know — Riley's been before, Jordan knows food, Alex handles logistics, Sam handles stays. The trip planner agent weaves it all together. The budget tracker keeps everyone honest. Nobody needs to be in a group chat arguing — they just drop their input when they have it, targeted to the right session. The floor becomes the trip bible.
