# Signup Flow — Design & Todos

## Current State

User clicks "Get started" on the landing page → Google OAuth → user/org created in DB → redirect to dashboard. No plan differentiation, no onboarding, no Slack connection prompt. New users land on an empty dashboard with no guidance.

## Target State

A user who signs up should experience a smooth path from landing page to their first live session:

1. Choose a plan (or default to free)
2. Sign up with Google
3. Connect their Slack workspace
4. Install the CLI
5. Join a channel and start their first session

Each step should feel intentional, not accidental. The user should never be left wondering "what do I do next?"

---

## Design

### Plan Selection → Signup

The pricing cards on the landing page link to `/signup?plan=free` or `/signup?plan=team`. Enterprise goes to `mailto:support@withpolaris.ai`. The plan parameter is stored in the OAuth state, survives the Google redirect, and is persisted on the org record after signup.

If no plan is specified (e.g., user clicks the nav "Sign up" button), default to `free`.

### Post-Signup Routing

After Google OAuth completes, the callback handler should route based on the user's state:

| Scenario | Route to |
|---|---|
| Existing user (login) | Dashboard |
| New user, existing org | Dashboard (org already set up) |
| New user, new org, no Slack | Onboarding: Connect Slack |
| New user, new org, Slack connected | Onboarding: Install CLI |

### Onboarding Flow

A dedicated onboarding page replaces the empty dashboard for new orgs. Three steps, shown as a checklist:

**Step 1: Connect Slack**
- Large "Add to Slack" button
- Explain: "Polaris uses Slack as the collaboration layer. Connect your workspace to get started."
- After connecting, auto-advance to Step 2

**Step 2: Install the CLI**
- Show `npx @lightupai/polaris` with a copy button
- Explain: "Run this on your machine to set up hooks and log in."
- A "I've installed it" button to advance (or auto-detect via CLI auth callback)

**Step 3: Start a session**
- Show `/polaris join #your-channel` with a copy button
- Explain: "Run this in Claude Code to start streaming your session."
- Link to dashboard

The existing `renderWelcomePage` and `renderSetupView` functions can be repurposed for this flow.

### Welcome Email

After a new user signs up, send a welcome email to their address from `hello@withpolaris.ai`:

- Welcome to Polaris
- Quick start: Connect Slack → Install CLI → Join a channel
- Link to community (GitHub Discussions)
- Link to support (support@withpolaris.ai)

Requires an email sending service (Resend, SendGrid, or Postmark). Cloudflare email routing only handles inbound — outbound needs a transactional email provider.

### Plan Enforcement

Plans are stored on the org record. Limits are enforced at the event ingestion layer:

| | Free | Team | Enterprise |
|---|---|---|---|
| Users | Unlimited | Unlimited | Unlimited |
| Prompts/month | 1,000 | 10,000 | Custom |
| Data captured | 5 GB | 50 GB | Custom |
| Retention | 7 days | 90 days | Custom |

**Enforcement approach:**
- Count user prompts per org per calendar month (query events table)
- Track cumulative data volume per org per month
- Run a daily cleanup job to delete events beyond the retention window
- When a limit is reached, soft-block: stop capturing new events but keep Slack streaming active. Show upgrade prompt in dashboard and optionally in Slack.

### Upgrade Flow

When a free-tier org approaches or hits their limit:

1. Dashboard shows a usage bar with current/max for prompts and data
2. At 80%, show a yellow warning: "You've used 80% of your free prompts this month"
3. At 100%, show upgrade prompt: "You've reached your free plan limit. Upgrade to Team for 10x capacity."
4. Upgrade button links to Stripe Checkout for the $49/mo Team plan
5. After successful payment, Stripe webhook updates the org's plan to `team`

### Billing (Stripe)

**Setup needed:**
- Stripe product: "Polaris Team"
- Stripe price: $49/month, recurring
- Checkout session: created when user clicks "Upgrade" or selects Team plan during signup
- Webhook endpoint: `/stripe/webhook` to handle `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
- Org record fields: `stripe_customer_id`, `stripe_subscription_id`, `plan`, `plan_status`

**Downgrade:**
- User cancels in Stripe customer portal
- Webhook fires `customer.subscription.deleted`
- Org plan reverts to `free`
- Free plan limits take effect at next billing cycle

---

## Todos

### Phase 1: Foundation (do first)

- [ ] **Store selected plan on org record**
  Add a `plan` column to the orgs table (free/team/enterprise, default 'free'). Populate from the `?plan` query param during signup. Show current plan on the dashboard.

- [ ] **Prompt Slack connection immediately after signup**
  For new orgs without Slack connected, route to setup view with prominent "Add to Slack" button instead of empty dashboard. Ensure the flow from signup → setup is seamless.

- [ ] **Post-signup onboarding flow**
  After a brand new org signup, redirect to onboarding page (not dashboard). Three steps: Connect Slack → Install CLI → Join a channel. Repurpose existing `renderWelcomePage`/`renderSetupView`. Auto-advance when each step is completed.

### Phase 2: Billing

- [ ] **Stripe integration for Team plan billing**
  Stripe product/price setup, checkout session on Team plan selection, webhook handler for payment events, store subscription status on org. Handle both new signups selecting Team and existing free users upgrading.

- [ ] **Enforce free tier usage limits**
  Prompt counter per org per month, data volume tracking, auto-cleanup of events beyond retention window. Soft-block at limits (stop capture, keep streaming, show upgrade prompt).

- [ ] **Upgrade prompt when limits are reached**
  Usage bars on dashboard, warning at 80%, upgrade prompt at 100%. Link to Stripe checkout. Also notify in Slack when org approaches limit.

- [ ] **Plan management page in dashboard**
  Show current plan, usage stats (prompts, data, retention), upgrade/downgrade buttons, Stripe customer portal link. Accessible from profile dropdown.

### Phase 3: Polish

- [ ] **Welcome email on signup**
  Pick a transactional email service (Resend recommended — simple API, good deliverability, free tier). Send welcome email with quick-start steps and community link. Send from hello@withpolaris.ai.

---

## Dependencies

```
Store plan on org ──→ Enforce limits ──→ Upgrade prompt
                 ──→ Stripe billing ──→ Plan management page
                 ──→ Onboarding flow

Prompt Slack connection ──→ Onboarding flow

Welcome email (independent — needs email service selection)
```

## Open Questions

- Should we allow plan changes mid-month, or only at billing cycle boundaries?
- Should free-tier users who hit limits lose access to existing session data, or just stop capturing new data?
- Do we want a 14-day free trial of Team, or keep it strictly free-then-pay?
- Should the CLI install step in onboarding auto-detect completion (via the `/auth/cli` callback), or require manual confirmation?
