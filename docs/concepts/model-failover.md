---
summary: "How OpenClaw rotates auth profiles and falls back across models"
read_when:
  - Diagnosing auth profile rotation, cooldowns, or model fallback behavior
  - Updating failover rules for auth profiles or models
  - Understanding how session model overrides interact with fallback retries
title: "Model failover"
sidebarTitle: "Model failover"
---

OpenClaw handles failures in two stages:

1. **Auth profile rotation** within the current provider.
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

This doc explains the runtime rules and the data that backs them.

## Runtime flow

For a normal text run, OpenClaw evaluates candidates in this order:

<Steps>
  <Step title="Resolve session state">
    Resolve the active session model and auth-profile preference.
  </Step>
  <Step title="Build candidate chain">
    Build the model candidate chain from the current model selection and the fallback policy for that selection source. Configured defaults, cron job primaries, and auto-selected fallback models can use configured fallbacks; explicit user session selections are strict.
  </Step>
  <Step title="Try the current provider">
    Try the current provider with auth-profile rotation/cooldown rules.
  </Step>
  <Step title="Advance on failover-worthy errors">
    If that provider is exhausted with a failover-worthy error, move to the next model candidate.
  </Step>
  <Step title="Persist fallback override">
    Persist the selected fallback override before the retry starts so other session readers see the same provider/model the runner is about to use. The persisted model override is marked `modelOverrideSource: "auto"`.
  </Step>
  <Step title="Roll back narrowly on failure">
    If the fallback candidate fails, roll back only the fallback-owned session override fields when they still match that failed candidate.
  </Step>
  <Step title="Throw FallbackSummaryError if exhausted">
    If every candidate fails, throw a `FallbackSummaryError` with per-attempt detail and the soonest cooldown expiry when one is known.
  </Step>
</Steps>

This is intentionally narrower than "save and restore the whole session". The reply runner only persists the model-selection fields it owns for fallback:

- `providerOverride`
- `modelOverride`
- `modelOverrideSource`
- `authProfileOverride`
- `authProfileOverrideSource`
- `authProfileOverrideCompactionCount`

That prevents a failed fallback retry from overwriting newer unrelated session mutations such as manual `/model` changes or session rotation updates that happened while the attempt was running.

## Selection source policy

OpenClaw separates the selected provider/model from why it was selected. That source controls whether the fallback chain is allowed:

- **Configured default**: `agents.defaults.model.primary` uses `agents.defaults.model.fallbacks`.
- **Agent primary**: `agents.list[].model` is strict unless that agent model object includes its own `fallbacks`. Use `fallbacks: []` to make the strict behavior explicit, or provide a non-empty list to opt that agent into model fallback.
- **Auto fallback override**: a runtime fallback writes `providerOverride`, `modelOverride`, `modelOverrideSource: "auto"`, and the selected origin model before retrying. That auto override can keep walking the configured fallback chain and is cleared by `/new`, `/reset`, and `sessions.reset`. Heartbeat runs without an explicit `heartbeat.model` also clear a direct auto override when its origin no longer matches the current configured default.
- **User session override**: `/model`, the model picker, `session_status(model=...)`, and `sessions.patch` write `modelOverrideSource: "user"`. That is an exact session selection. If the selected provider/model fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated configured fallback.
- **Legacy session override**: older session entries may have `modelOverride` without `modelOverrideSource`. OpenClaw treats those as user overrides so an explicit old selection is not silently converted into fallback behavior.
- **Cron payload model**: a cron job `payload.model` / `--model` is a job primary, not a user session override. It uses configured fallbacks unless the job provides `payload.fallbacks`; `payload.fallbacks: []` makes the cron run strict.

## Auth storage (keys + OAuth)

OpenClaw uses **auth profiles** for both API keys and OAuth tokens.

- Secrets live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Runtime auth-routing state lives in `~/.openclaw/agents/<agentId>/agent/auth-state.json`.
- Config `auth.profiles` / `auth.order` are **metadata + routing only** (no secrets).
- Legacy import-only OAuth file: `~/.openclaw/credentials/oauth.json` (imported into `auth-profiles.json` on first use).

More detail: [OAuth](/concepts/oauth)

Credential types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)

## Profile IDs

OAuth logins create distinct profiles so multiple accounts can coexist.

- Default: `provider:default` when no email is available.
- OAuth with email: `provider:<email>` (for example `google-antigravity:user@gmail.com`).

Profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles`.

## Rotation order

When a provider has multiple profiles, OpenClaw chooses an order like this:

<Steps>
  <Step title="Explicit config">
    `auth.order[provider]` (if set).
  </Step>
  <Step title="Configured profiles">
    `auth.profiles` filtered by provider.
  </Step>
  <Step title="Stored profiles">
    Entries in `auth-profiles.json` for the provider.
  </Step>
</Steps>

If no explicit order is configured, OpenClaw uses a round-robin order:

- **Primary key:** profile type (**OAuth before API keys**).
- **Secondary key:** `usageStats.lastUsed` (oldest first, within each type).
- **Cooldown/disabled profiles** are moved to the end, ordered by soonest expiry.

### Session stickiness (cache-friendly)

OpenClaw **pins the chosen auth profile per session** to keep provider caches warm. It does **not** rotate on every request. The pinned profile is reused until:

- the session is reset (`/new` / `/reset`)
- a compaction completes (compaction count increments)
- the profile is in cooldown/disabled

Manual selection via `/model …@<profileId>` sets a **user override** for that session and is not auto-rotated until a new session starts.

<Note>
Auto-pinned profiles (selected by the session router) are treated as a **preference**: they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts. User-pinned profiles stay locked to that profile; if it fails and model fallbacks are configured, OpenClaw moves to the next model instead of switching profiles.
</Note>

### Why OAuth can "look lost"

If you have both an OAuth profile and an API key profile for the same provider, round-robin can switch between them across messages unless pinned. To force a single profile:

- Pin with `auth.order[provider] = ["provider:profileId"]`, or
- Use a per-session override via `/model …` with a profile override (when supported by your UI/chat surface).

## Cooldowns

When a profile fails due to auth/rate-limit errors (or a timeout that looks like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.

<AccordionGroup>
  <Accordion title="What lands in the rate-limit / timeout bucket">
    That rate-limit bucket is broader than plain `429`: it also includes provider messages such as `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, `throttled`, `resource exhausted`, and periodic usage-window limits such as `weekly/monthly limit reached`.

    Format/invalid-request errors are usually terminal because retrying the same payload would fail the same way, so OpenClaw surfaces them instead of rotating auth profiles. Known retry-repair paths can opt in explicitly: for example Cloud Code Assist tool call ID validation failures are sanitized and retried once through the `allowFormatRetry` policy. OpenAI-compatible stop-reason errors such as `Unhandled stop reason: error`, `stop reason: error`, and `reason: error` are classified as timeout/failover signals.

    Generic server text can also land in that timeout bucket when the source matches a known transient pattern. For example, the bare pi-ai stream-wrapper message `An unknown error occurred` is treated as failover-worthy for every provider because pi-ai emits it when provider streams end with `stopReason: "aborted"` or `stopReason: "error"` without specific details. JSON `api_error` payloads with transient server text such as `internal server error`, `unknown error, 520`, `upstream error`, or `backend error` are also treated as failover-worthy timeouts.

    OpenRouter-specific generic upstream text such as bare `Provider returned error` is treated as timeout only when the provider context is actually OpenRouter. Generic internal fallback text such as `LLM request failed with an unknown error.` stays conservative and does not trigger failover by itself.

  </Accordion>
  <Accordion title="SDK retry-after caps">
    Some provider SDKs may otherwise sleep for a long `Retry-After` window before returning control to OpenClaw. For Stainless-based SDKs such as Anthropic and OpenAI, OpenClaw caps SDK-internal `retry-after-ms` / `retry-after` waits at 60 seconds by default and surfaces longer retryable responses immediately so this failover path can run. Tune or disable the cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS`; see [Retry behavior](/concepts/retry).
  </Accordion>
  <Accordion title="Model-scoped cooldowns">
    Rate-limit cooldowns can also be model-scoped:

    - OpenClaw records `cooldownModel` for rate-limit failures when the failing model id is known.
    - A sibling model on the same provider can still be tried when the cooldown is scoped to a different model.
    - Billing/disabled windows still block the whole profile across models.

  </Accordion>
</AccordionGroup>

Cooldowns use exponential backoff:

- 1 minute
- 5 minutes
- 25 minutes
- 1 hour (cap)

State is stored in `auth-state.json` under `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Billing disables

Billing/credit failures (for example "insufficient credits" / "credit balance too low") are treated as failover-worthy, but they're usually not transient. Instead of a short cooldown, OpenClaw marks the profile as **disabled** (with a longer backoff) and rotates to the next profile/provider.

<Note>
Not every billing-shaped response is `402`, and not every HTTP `402` lands here. OpenClaw keeps explicit billing text in the billing lane even when a provider returns `401` or `403` instead, but provider-specific matchers stay scoped to the provider that owns them (for example OpenRouter `403 Key limit exceeded`).

Meanwhile temporary `402` usage-window and organization/workspace spend-limit errors are classified as `rate_limit` when the message looks retryable (for example `weekly usage limit exhausted`, `daily limit reached, resets tomorrow`, or `organization spending limit exceeded`). Those stay on the short cooldown/failover path instead of the long billing-disable path.
</Note>

State is stored in `auth-state.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Defaults:

- Billing backoff starts at **5 hours**, doubles per billing failure, and caps at **24 hours**.
- Backoff counters reset if the profile hasn't failed for **24 hours** (configurable).
- Overloaded retries allow **1 same-provider profile rotation** before model fallback.
- Overloaded retries use **0 ms backoff** by default.

## Model fallback

If all profiles for a provider fail, OpenClaw moves to the next model in `agents.defaults.model.fallbacks`. This applies to auth failures, rate limits, and timeouts that exhausted profile rotation (other errors do not advance fallback). Provider errors that do not expose enough detail are still labeled precisely in fallback state: `empty_response` means the provider returned no usable message or status, `no_error_details` means the provider explicitly returned `Unknown error (no error details in response)`, and `unclassified` means OpenClaw preserved the raw preview but no classifier matched it yet.

Overloaded and rate-limit errors are handled more aggressively than billing cooldowns. By default, OpenClaw allows one same-provider auth-profile retry, then switches to the next configured model fallback without waiting. Provider-busy signals such as `ModelNotReadyException` land in that overloaded bucket. Tune this with `auth.cooldowns.overloadedProfileRotations`, `auth.cooldowns.overloadedBackoffMs`, and `auth.cooldowns.rateLimitedProfileRotations`.

When a run starts from the configured default primary, a cron job primary, an agent primary with explicit fallbacks, or an auto-selected fallback override, OpenClaw can walk the matching configured fallback chain. Agent primaries without explicit fallbacks and explicit user selections (for example `/model ollama/qwen3.5:27b`, the model picker, `sessions.patch`, or one-off CLI provider/model overrides) are strict: if that provider/model is unreachable or fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated fallback.

### Candidate chain rules

OpenClaw builds the candidate list from the currently requested `provider/model` plus configured fallbacks.

<AccordionGroup>
  <Accordion title="Rules">
    - The requested model is always first.
    - Explicit configured fallbacks are deduplicated but not filtered by the model allowlist. They are treated as explicit operator intent.
    - If the current run is already on a configured fallback in the same provider family, OpenClaw keeps using the full configured chain.
    - If the current run is on a different provider than config and that current model is not already part of the configured fallback chain, OpenClaw does not append unrelated configured fallbacks from another provider.
    - When no explicit fallback override is supplied to the fallback runner, the configured primary is appended at the end so the chain can settle back onto the normal default once earlier candidates are exhausted.
    - When a caller supplies `fallbacksOverride`, the runner uses exactly the requested model plus that override list. An empty list disables model fallback and prevents the configured primary from being appended as a hidden retry target.

  </Accordion>
</AccordionGroup>

### Which errors advance fallback

<Tabs>
  <Tab title="Continues on">
    - auth failures
    - rate limits and cooldown exhaustion
    - overloaded/provider-busy errors
    - timeout-shaped failover errors
    - billing disables
    - `LiveSessionModelSwitchError`, which is normalized into a failover path so a stale persisted model does not create an outer retry loop
    - other unrecognized errors when there are still remaining candidates

  </Tab>
  <Tab title="Does not continue on">
    - explicit aborts that are not timeout/failover-shaped
    - context overflow errors that should stay inside compaction/retry logic (for example `request_too_large`, `INVALID_ARGUMENT: input exceeds the maximum number of tokens`, `input token count exceeds the maximum number of input tokens`, `The input is too long for the model`, or `ollama error: context length exceeded`)
    - a final unknown error when there are no candidates left

  </Tab>
</Tabs>

### Cooldown skip vs probe behavior

When every auth profile for a provider is already in cooldown, OpenClaw does not automatically skip that provider forever. It makes a per-candidate decision:

<AccordionGroup>
  <Accordion title="Per-candidate decisions">
    - Persistent auth failures skip the whole provider immediately.
    - Billing disables usually skip, but the primary candidate can still be probed on a throttle so recovery is possible without restarting.
    - The primary candidate may be probed near cooldown expiry, with a per-provider throttle.
    - Same-provider fallback siblings can be attempted despite cooldown when the failure looks transient (`rate_limit`, `overloaded`, or unknown). This is especially relevant when a rate limit is model-scoped and a sibling model may still recover immediately.
    - Transient cooldown probes are limited to one per provider per fallback run so a single provider does not stall cross-provider fallback.

  </Accordion>
</AccordionGroup>

## Session overrides and live model switching

Session model changes are shared state. The active runner, `/model` command, compaction/session updates, and live-session reconciliation all read or write parts of the same session entry.

That means fallback retries have to coordinate with live model switching:

- Only explicit user-driven model changes mark a pending live switch. That includes `/model`, `session_status(model=...)`, and `sessions.patch`.
- System-driven model changes such as fallback rotation, heartbeat overrides, or compaction never mark a pending live switch on their own.
- User-driven model overrides are treated as exact selections for fallback policy, so an unreachable selected provider surfaces as a failure instead of being masked by `agents.defaults.model.fallbacks`.
- Before a fallback retry starts, the reply runner persists the selected fallback override fields to the session entry.
- Auto fallback overrides remain selected on subsequent turns so OpenClaw does not probe a known-bad primary on every message. `/new`, `/reset`, and `sessions.reset` clear auto-sourced overrides and return the session to the configured default.
- `/status` shows the selected model and, when fallback state differs, the active fallback model and reason.
- Live-session reconciliation prefers persisted session overrides over stale runtime model fields.
- If a live-switch error points at a later candidate in the active fallback chain, OpenClaw jumps directly to that selected model instead of walking unrelated candidates first.
- If the fallback attempt fails, the runner rolls back only the override fields it wrote, and only if they still match that failed candidate.

This prevents the classic race:

<Steps>
  <Step title="Primary fails">
    The selected primary model fails.
  </Step>
  <Step title="Fallback chosen in memory">
    Fallback candidate is chosen in memory.
  </Step>
  <Step title="Session store still says old primary">
    Session store still reflects the old primary.
  </Step>
  <Step title="Live reconciliation reads stale state">
    Live-session reconciliation reads the stale session state.
  </Step>
  <Step title="Retry snapped back">
    The retry gets snapped back to the old model before the fallback attempt starts.
  </Step>
</Steps>

The persisted fallback override closes that window, and the narrow rollback keeps newer manual or runtime session changes intact.

## Observability and failure summaries

`runWithModelFallback(...)` records per-attempt details that feed logs and user-facing cooldown messaging:

- provider/model attempted
- reason (`rate_limit`, `overloaded`, `billing`, `auth`, `model_not_found`, and similar failover reasons)
- optional status/code
- human-readable error summary

Structured `model_fallback_decision` logs also include flat `fallbackStep*` fields when a candidate fails, is skipped, or a later fallback succeeds. These fields make the attempted transition explicit (`fallbackStepFromModel`, `fallbackStepToModel`, `fallbackStepFromFailureReason`, `fallbackStepFromFailureDetail`, `fallbackStepFinalOutcome`) so log and diagnostic exporters can reconstruct the primary failure even when the terminal fallback also fails.

When every candidate fails, OpenClaw throws `FallbackSummaryError`. The outer reply runner can use that to build a more specific message such as "all models are temporarily rate-limited" and include the soonest cooldown expiry when one is known.

That cooldown summary is model-aware:

- unrelated model-scoped rate limits are ignored for the attempted provider/model chain
- if the remaining block is a matching model-scoped rate limit, OpenClaw reports the last matching expiry that still blocks that model

## Related config

See [Gateway configuration](/gateway/configuration) for:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `auth.cooldowns.overloadedProfileRotations` / `auth.cooldowns.overloadedBackoffMs`
- `auth.cooldowns.rateLimitedProfileRotations`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

See [Models](/concepts/models) for the broader model selection and fallback overview.
