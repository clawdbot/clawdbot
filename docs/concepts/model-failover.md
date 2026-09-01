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

The embedded runner also performs bounded same-model recovery. When a transient
network failure interrupts a provider call before any assistant content or tool
call is produced, the provider records a transport-failure diagnostic. After a
settled tool batch, this lets the runner continue from the current transcript up
to twice without rerunning those tools. Partial responses and unfinished tool
batches do not qualify for this recovery. No additional retry configuration is
required.

## Runtime flow

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
  <Step title="Use fallback for the current turn">
    Run the winning fallback candidate without changing the session's selected provider/model.
  </Step>
  <Step title="Retry safe pure overload exhaustion">
    If every candidate fails only because providers are overloaded, retry the full turn-local chain up to 10 times with exponential backoff while no tool execution or assistant output has started. After 30 seconds, send one status notice so the user is not left waiting silently.
  </Step>
  <Step title="Throw FailoverError if exhausted">
    If every candidate fails, throw a `FailoverError` with structured per-attempt detail and the soonest cooldown expiry when one is known.
  </Step>
</Steps>

Fallback execution is turn-local. The reply runner persists only fallback notice state so `/status` and transition notices can distinguish the selected model from the model that answered; it does not persist the fallback as the next turn's model selection.

## Selection source policy

The selection source controls whether the fallback chain is allowed:

- **Configured default**: `agents.defaults.model.primary` uses `agents.defaults.model.fallbacks`.
- **Agent primary**: `agents.entries.*.model` is strict unless that agent's model object includes its own `fallbacks`. Use `fallbacks: []` to make the strict behavior explicit, or a non-empty list to opt that agent into model fallback.
- **Runtime fallback**: the fallback candidate applies only to the current turn. The next turn starts from the selected primary again. OpenClaw still recognizes previously stored `modelOverrideSource: "auto"` entries, probes their configured origin every 5 minutes, and clears them once the origin recovers. `/new`, `/reset`, and `sessions.reset` also clear those entries.
- **User session override**: `/model`, the model picker, `session_status(model=...)`, and `sessions.patch` write `modelOverrideSource: "user"`. This is an exact session selection. If the selected provider/model fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated configured fallback.
- **Legacy session override**: older session entries may have `modelOverride` without `modelOverrideSource`. OpenClaw treats those as user overrides so an explicit old selection is not silently converted into fallback behavior.
- **Cron payload model**: a cron job `payload.model` / `--model` is a job primary, not a user session override. It uses configured fallbacks unless the job provides `payload.fallbacks`; `payload.fallbacks: []` makes the cron run strict.

Outside group and channel conversations, OpenClaw sends a visible notice when a turn moves onto fallback and another notice when a later turn succeeds on the selected primary. Group and channel conversations keep the same fallback state and lifecycle events without posting these notices. Persisted notice state prevents repeated notices when consecutive turns use the same selected/active pair, while model selection itself remains unchanged.

## Auth failure skip cache

By default, every new turn keeps the existing fallback retry behavior: OpenClaw retries each configured fallback candidate again, including non-primary candidates that recently failed with `auth` or `auth_permanent`.

Opt in to suppress repeat auth failures with:

```bash
OPENCLAW_FALLBACK_SKIP_TTL_MS=60000
```

When enabled, OpenClaw records an in-memory, session-scoped skip marker for a non-primary fallback candidate after an auth-class failure. The key includes the session, provider, model, and selected automatic or explicit profile ID. Switching profiles does not inherit another profile's failure marker. Primary candidates are never skipped, so an explicit user model selection still surfaces the real auth error. The cache is process-local and clears on Gateway restart.

The value is a TTL in milliseconds. `0` or unset disables the cache. Positive values are clamped between 1 second and 10 minutes.

## User-visible fallback notices

Outside group and channel conversations, OpenClaw sends a status notice in the same reply surface when a session moves onto an auto-selected fallback:

```text
↪️ Model Fallback: <fallback> (selected <primary>; <reason>)
```

When a later probe succeeds and the session returns to the selected primary, OpenClaw sends:

```text
↪️ Model Fallback cleared: <primary> (was <fallback>)
```

These notices are operational messages, not assistant content. They deliver once per state change outside group and channel conversations, including side-effect-only turns when feasible, but repeated turn-local fallback transitions do not repeat them. Group and channel conversations suppress the visible notices while retaining the same fallback state and lifecycle events. Delivery bypasses normal source-reply suppression, does not consume the first assistant reply slot for threaded channels, and is excluded from text-to-speech.

## Auth storage (keys + OAuth)

OpenClaw uses **auth profiles** for both API keys and OAuth tokens.

- Secrets and runtime auth-routing state live in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`.
- Config `auth.profiles` / `auth.order` are **metadata + routing only** (no secrets).
- Legacy `credentials/oauth.json`, `auth-profiles.json`, `auth-state.json`, and
  per-agent `auth.json` files are imported only by `openclaw doctor --fix`.
  Runtime fails closed for the affected agent until credential-bearing legacy
  files are migrated; it never silently imports or falls back to them.

More detail: [OAuth](/concepts/oauth)

Credential types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)
- `type: "token"` → static bearer-style token, optionally expiring; OpenClaw does not refresh it (used for `aws-sdk` and other credential-chain auth modes)

## Profile IDs

OAuth logins create distinct profiles so multiple accounts can coexist.

- Default: `provider:default` when no email is available.
- OAuth with email: `provider:<email>` (for example `openai:user@example.com`).

Profiles live in the per-agent `openclaw-agent.sqlite` auth profile store.

## Rotation order

When a provider has multiple profiles, OpenClaw chooses an order like this:

<Steps>
  <Step title="Stored order override">
    The per-agent order set with `openclaw models auth order set --provider <id> <profileIds...>`.
  </Step>
  <Step title="Explicit config">
    `auth.order[provider]` (if set).
  </Step>
  <Step title="Configured profiles">
    `auth.profiles` filtered by provider.
  </Step>
  <Step title="Stored profiles">
    Per-agent SQLite auth profile entries for the provider.
  </Step>
</Steps>

If no explicit order is configured, OpenClaw uses a round-robin order:

- **Primary key:** profile type (**OAuth, then static token, then API key**).
- **Secondary key for OAuth:** profiles with a currently usable access token before
  profiles whose access token is expired. Expired OAuth profiles stay eligible so
  the runtime can refresh them when no usable peer is available.
- **Next key:** `usageStats.lastUsed` (oldest first, within each type/state tier).
- **Cooldown/disabled profiles** are moved to the end, ordered by soonest expiry.

### Session stickiness (cache-friendly)

OpenClaw **pins the automatically chosen auth profile per session** to keep provider caches warm. It does **not** rotate on every request. An automatic pin may rotate or clear when:

- the session is reset (`/new` / `/reset`)
- a compaction completes (compaction count increments)
- the profile is in cooldown/disabled

Manual selection via `/model …@<profileId> -s` sets a **user override**. A valid user pin survives `/new`, `/reset`, session rollover, compaction, and cooldown windows. It remains the first preference when eligible; while that exact profile is in cooldown or disabled, OpenClaw tries the next eligible same-provider profile without replacing the stored pin. OpenClaw clears the pin when the profile disappears, no longer matches the selected provider, or the user selects another explicit profile. `/model default -s` clears the model override while retaining a compatible auth pin and clearing an incompatible one.

<Note>
Auto-pinned and user-pinned auth profiles are both retry preferences: OpenClaw tries the selected profile first while it is eligible, then may rotate to another same-provider profile on auth failures, rate limits, billing limits, or timeouts. A user pin stays persisted during that temporary rotation, so new runs prefer it again after its cooldown expires without changing the selected model or runtime. This auth rotation does not loosen model selection: an explicit user provider/model selection remains strict and reports failure after its same-provider auth profiles are exhausted.
</Note>

### OpenAI Codex subscription plus API-key backup

For OpenAI agent models, auth and runtime are separate. `openai/gpt-*` stays on the Codex harness while auth can rotate between a Codex subscription profile and an OpenAI API-key backup.

Use `auth.order.openai` for the user-facing order:

```json5
{
  auth: {
    order: {
      openai: ["openai:user@example.com", "openai:api-key-backup"],
    },
  },
}
```

Use `openai:*` for both ChatGPT/Codex OAuth profiles and OpenAI API-key profiles. When the subscription hits a Codex usage limit, OpenClaw records the exact reset time when Codex provides one, tries the next ordered auth profile, and keeps the run inside the Codex harness. Once the reset time passes, the subscription profile is eligible again and the next automatic selection can return to it.

Use a user-pinned profile to make one account/key the durable first preference for that session. If it becomes unavailable, OpenClaw temporarily rotates through the remaining eligible `auth.order.openai` profiles and returns to the pinned profile after recovery.

## Cooldowns

When a profile fails due to auth/rate-limit errors (or a timeout that looks like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.

CLI-backed runtimes settle profile health only after their resume, fork, and fresh-session recovery attempts finish. A terminal credential failure cools down the exact selected profile before model fallback; a successful run clears stale failure state. Transcript, format, context, pre-provider timeout, and ambient CLI failures without a selected profile do not change shared profile health.

<AccordionGroup>
  <Accordion title="What lands in the rate-limit / timeout bucket">
    That rate-limit bucket is broader than plain `429`: it also includes provider messages such as `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, `throttled`, `resource exhausted`, and periodic usage-window limits such as `weekly limit reached` or `monthly limit exhausted`.

    Format/invalid-request errors are usually terminal because retrying the same payload would fail the same way, so OpenClaw surfaces them instead of rotating auth profiles. Known retry-repair paths can opt in explicitly: for example Cloud Code Assist tool call ID validation failures are sanitized and retried once through the `allowFormatRetry` policy.

    OpenAI-compatible **provider-completed** stop/finish reasons such as `Unhandled stop reason: error`, `stop reason: error`, `reason: error`, and `Provider finish_reason: error` are classified as **`server_error`** (HTTP-like status 500), not timeout. They remain failover-eligible for model/profile rotation, but diagnostics keep the provider finish-reason text instead of rewriting the user copy to "LLM request timed out." Transport-shaped finish reasons such as `Provider finish_reason: abort`, `network_error`, and `malformed_response` stay in the timeout/failover bucket (status 408).

    Generic server text can also land in that timeout bucket when the source matches a known transient pattern. For example, the bare model runtime stream-wrapper message `An unknown error occurred` is treated as failover-worthy for every provider because the shared model runtime emits it when provider streams end with `stopReason: "aborted"` or `stopReason: "error"` without specific details. JSON `api_error` payloads with transient server text such as `internal server error`, `unknown error, 520`, `upstream error`, or `backend error` are also treated as failover-worthy timeouts.

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

Regular (non-billing, non-auth-permanent) cooldowns scale with the profile's recent error count:

- 1st failure: 30 seconds
- 2nd failure: 1 minute
- 3rd+ failure: 5 minutes (cap)

Counters reset once the profile's built-in failure window has passed.

State is stored in the per-agent SQLite auth state under `usageStats`:

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

High-confidence permanent-auth failures (revoked/deactivated keys, deactivated workspaces) get a similar disabled lane, but recover much sooner than billing since some providers surface auth-looking payloads transiently during incidents.

State is stored in the per-agent SQLite auth state:

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

Overloaded and rate-limit errors are handled more aggressively than billing cooldowns: by default, OpenClaw allows one same-provider auth-profile retry, then switches to the next configured model fallback without waiting.

## Model fallback

If all profiles for a provider fail, OpenClaw moves to the next model in `agents.defaults.model.fallbacks` when the failure matches one of the failover reasons listed below. This includes `model_not_found` for HTTP 404 responses unless the response body identifies a more specific condition such as context overflow, session expiry, billing, authentication, or request format. Provider errors that do not expose enough detail are still labeled precisely in fallback state: `empty_response` means the provider returned no usable message or status, `no_error_details` means the provider explicitly returned `Unknown error (no error details in response)`, and `unclassified` means OpenClaw preserved the raw preview but no classifier matched it yet.

Provider-busy signals such as `ModelNotReadyException` land in the overloaded bucket and follow the same one-rotation-then-fallback policy as rate limits (see the defaults table above).

If the entire candidate chain is exhausted only by overload failures, the reply runner retries the chain up to 10 times in the same turn. Full-turn retry is allowed only before tool execution or assistant output starts, avoiding duplicate mutations or messages if an overload arrives after observable work. Backoff starts at 2.5 seconds and doubles to a 30-second cap. Once the turn has been waiting for 30 seconds, OpenClaw sends one transient status notice: `The AI service is temporarily overloaded. I’m still retrying; this may take a few minutes.` The retry and any fallback winner remain turn-local; ordinary transient server errors retain their separate one-retry policy.

When a run starts from the configured default primary, a cron job primary, an agent primary with explicit fallbacks, or an auto-selected fallback override, OpenClaw can walk the matching configured fallback chain. Agent primaries without explicit fallbacks and explicit user selections (for example `/model ollama/qwen3.5:27b`, the model picker, `sessions.patch`, or one-off CLI provider/model overrides) are strict: if that provider/model is unreachable or fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated fallback.

### Candidate chain rules

OpenClaw builds the candidate list from the currently requested `provider/model` plus configured fallbacks.

<AccordionGroup>
  <Accordion title="Rules">
    - The requested model is always first.
    - Explicit configured fallbacks are deduplicated but not filtered by the model allowlist. They are treated as explicit operator intent.
    - If the current run is already on a configured fallback in the same provider family, OpenClaw keeps using the full configured chain.
    - When no explicit fallback override is supplied, configured fallbacks are tried before the configured primary even if the requested model uses a different provider.
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
    - `model_not_found`, including eligible HTTP 404 responses
    - `LiveSessionModelSwitchError` for a stale current or earlier candidate; later configured targets redirect directly, while targets outside the chain return to the bounded session-model retry owner
    - a provider request-size ceiling reaching the fallback boundary, which happens when a transport-owning plugin harness bypasses embedded recovery. The ceiling belongs to the refusing provider's quota rather than to any model's context window, so a differently provisioned candidate may still admit the request
    - other unrecognized errors when there are still remaining candidates

  </Tab>
  <Tab title="Does not continue on">
    - explicit aborts that are not timeout/failover-shaped
    - context overflow errors that should stay inside compaction/retry logic (for example `request_too_large`, `input token count exceeds the maximum number of input tokens`, `input exceeds the maximum number of tokens`, `input too long for the model`, or `ollama error: context length exceeded`)
    - context overflow inside an embedded run that has already been declared terminal, including a provider request-size ceiling (for example Groq's `413 ... on tokens per minute (TPM): Limit 8000, Requested 8098`), which the runner stops on rather than compacting
    - a final unknown error when there are no candidates left
    - Claude Fable 5 safety refusals; direct API-key requests handle those at the provider level via Anthropic's server-side fallback to `claude-opus-4-8` instead (see [Anthropic](/providers/anthropic#safety-refusal-fallback-claude-opus-5-and-fable-5))

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

Session model changes are shared state. The active runner, `/model` command, compaction/session updates, and live-session reconciliation all read or write parts of the same session entry. Fallback execution does not write model-selection fields, so it cannot replace a newer manual selection while retrying.

Live model switching follows these rules:

- Only explicit user-driven model changes mark a pending live switch. That includes `/model`, `session_status(model=...)`, and `sessions.patch`.
- System-driven model changes such as fallback rotation, heartbeat overrides, or compaction never mark a pending live switch on their own.
- User-driven model overrides are treated as exact selections for fallback policy, so an unreachable selected provider surfaces as a failure instead of being masked by `agents.defaults.model.fallbacks`.
- Runtime fallback candidates remain turn-local. The next turn starts from the current selected model, including a manual selection that arrived during the previous run.
- Previously stored auto fallback overrides remain supported: OpenClaw periodically probes their configured origin and clears the override when it recovers; `/new`, `/reset`, and `sessions.reset` clear auto-sourced overrides immediately.
- Outside group and channel conversations, user replies announce fallback transitions and fallback-cleared recovery once per state change. Repeated turns with the same selected/active pair do not repeat the notice; group and channel conversations retain the same fallback state and lifecycle events without posting it.
- `/status` shows the selected model and, when fallback state differs, the active fallback model and reason.
- Live-session reconciliation prefers persisted session overrides over stale runtime model fields.
- If a live-switch error points at a later candidate in the active fallback chain, OpenClaw jumps directly to that selected model instead of walking unrelated candidates first.
- If a live switch selects a model outside the active fallback chain, OpenClaw returns the original switch to the agent, reply, or isolated-cron retry owner so the selected model can complete the same turn.

The active run carries its chosen candidate directly. Live reconciliation changes that candidate only for an explicit pending user switch, so no temporary fallback override or rollback is needed.

## Observability and failure summaries

`runWithModelFallback(...)` records per-attempt details that feed logs and user-facing cooldown messaging:

- provider/model attempted
- reason (`rate_limit`, `overloaded`, `billing`, `auth`, `model_not_found`, and similar failover reasons)
- optional status/code
- human-readable error summary

Structured `model_fallback_decision` logs also include flat `fallbackStep*` fields when a candidate fails, is skipped, or a later fallback succeeds. These fields make the attempted transition explicit (`fallbackStepFromModel`, `fallbackStepToModel`, `fallbackStepFromFailureReason`, `fallbackStepFromFailureDetail`, `fallbackStepFinalOutcome`) so log and diagnostic exporters can reconstruct the primary failure even when the terminal fallback also fails.

For a missing-model fallback, look for a `model_fallback_decision` event whose `reason` or `fallbackStepFromFailureReason` is `model_not_found`.

When every candidate fails, OpenClaw throws `FailoverError` with structured attempt records. The outer reply runner can use those records to build a more specific message such as "all models are temporarily rate-limited" and include the soonest cooldown expiry when one is known.

That cooldown summary is model-aware:

- unrelated model-scoped rate limits are ignored for the attempted provider/model chain
- if the remaining block is a matching model-scoped rate limit, OpenClaw reports the last matching expiry that still blocks that model

## Related config

See [Gateway configuration](/gateway/configuration) for:

- `auth.profiles` / `auth.order`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

See [Models](/concepts/models) for the broader model selection and fallback overview.
