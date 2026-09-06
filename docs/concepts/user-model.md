---
summary: "Manage durable user preferences and your Gateway profile identity"
title: "User model"
read_when:
  - You want stable preferences to guide future sessions
  - You need to update a preference without leaving contradictory history
  - You are deciding whether something belongs in USER.md or MEMORY.md
  - You want verified GitHub identity and optional commit credit on your Gateway profile
  - You want to connect a personal or shared GitHub account for publication
---

`USER.md` is the optional user-model artifact in an agent workspace. It stores stable preferences, communication style, relationships, and active-project context as directives that can guide future sessions.

OpenClaw loads `USER.md` beside `MEMORY.md` at session start. It has a separate small bootstrap budget, and edits are picked up on later turns in a long-lived session. If the file is absent, startup continues without it.

## Gateway profile and GitHub credit

Your authenticated Gateway profile is separate from `USER.md`. Open **Settings → Profile → Identity** to set the display name and avatar shown to other people on the Gateway. A custom OpenClaw avatar remains authoritative when a GitHub account is verified. The Profile header follows your live user identity, including names cleared from another browser, even when several agents are configured; unidentified connections retain the default-agent preview.

A single-user Gateway gives unidentified operator connections one durable local owner profile, shared across devices and tabs, including device-token reconnects. The Gateway host account's full name fills an unset display name; a saved name is never overwritten. If no full name is available, the sidebar and Profile header show **Owner** until you set a name. Login names are not used. The owner profile has no email and does not change permissions or identity scopes. It cannot be merged with a personal profile or assigned an operator role; sign in with a personal identity for those operations. If an older build merged the owner profile into a person, connections stay unidentified and log a repair hint. Run `openclaw doctor --fix`, then reconnect to restore the owner identity. The person keeps their emails, role, and GitHub identities.

When `gateway.roles` is configured, unidentified operators receive the owner profile only with token or password authentication. Other connections need a profile-backed sign-in for personal identity. Node, ephemeral, and synthetic connections do not receive an owner profile.

On macOS, an owner without a saved avatar uses the Gateway host account's user picture. Uploading an avatar in **Settings → Profile → Identity** overrides that default. The picture stays a local, process-cached default rather than a saved profile upload; restart the Gateway after changing it in macOS. This applies only to the shared owner profile, not to people signed in with their own identities. Unavailable pictures fall back to initials.

GitHub-backed sign-in is supported through Cloudflare Access and Tailscale Serve. For Cloudflare Access, the Gateway accepts identity enrichment only after successful `trusted-proxy` authentication with the standard Access email header and a required Access assertion header. It calls the Access identity endpoint, requires the returned email to match the authenticated proxy principal and the identity provider to be GitHub, then resolves the canonical GitHub login from the returned numeric account id. For Tailscale Serve, the Gateway resolves the verified GitHub-backed Tailscale login through GitHub. Both paths record the immutable numeric account id plus the current canonical login.

For new profiles or an unset display name, OpenClaw prefers the public name from the verified GitHub account, falling back to the sign-in provider's name when GitHub has none. A saved name is upgraded only when it exactly matches the current canonical GitHub login, including case. All other saved names remain unchanged, including custom names and previously adopted full names. This takes effect on the next successful identity sync through sign-in, reconnect, or a Profile refresh that retries the lookup; existing profiles are not renamed in a background migration.

The **GitHub account** row is read-only. Generic trusted proxies, token, password, and unauthenticated connections cannot claim a GitHub account, and agent or tool GitHub credentials are never used for this identity. Public GitHub account lookups use the Gateway's configured `gateway.controlUi.github.token`, or its process `GH_TOKEN` / `GITHUB_TOKEN` when no credential is configured, to avoid the smaller anonymous API quota. That credential authenticates the API request only; the sign-in provider still determines the person's identity. The forwarded Cloudflare Access assertion is connection-scoped: OpenClaw does not persist, export, log, or expose it to the UI or model.

Cloudflare Access account lookups automatically share a bounded, in-memory GitHub metadata cache for 15 minutes, keyed by immutable account ID and API credential. Concurrent lookups share one GitHub request. Expired entries use ETags for conditional refresh when available; an authenticated `304 Not Modified` response does not consume GitHub's primary quota. Each new connection or authenticated HTTP request still checks Cloudflare Access, and local profile permissions use the current operator role. The cache does not store Access assertions or role decisions. Tailscale username lookups stay fresh because usernames can be renamed or reassigned.

When [operator roles](/gateway/operator-scopes#named-operator-roles) are configured, identity verification completes before the WebSocket connection is admitted. If verification is unavailable, the connection returns a retryable profile-verification error with recovery guidance; GitHub rate limits are identified explicitly. A verified Cloudflare email and immutable account ID can reuse their existing profile during a retryable GitHub outage. First-time users must complete verification before receiving role-based access.

On GitHub rate limits, the Gateway shares a cooldown across requests using the affected credential and quota bucket. Exhausting search quota does not block profile lookups; secondary limits can pause its other GitHub REST reads using that credential. Further API requests pause until GitHub's `Retry-After` deadline, or its primary reset deadline when remaining quota is zero. Secondary limits without `Retry-After` pause for 60 seconds. Control UI reconnects honor that delay and retain their normal backoff, so opening another tab does not restart GitHub requests against an exhausted bucket. If verification remains unavailable after the cooldown, ask an administrator to check the configured service credential and other workloads sharing its quota.

Without operator roles, identity lookup runs after WebSocket sign-in, so connection status and other identity-independent reads remain available. Profile and session work waits for the lookup; a Cloudflare or GitHub rate limit or network failure returns retryable unavailability without exposing a mutable alias or erasing a previously verified account. A later request, connection, or Profile refresh retries the lookup. GitHub login renames are reconciled by numeric account id so profile history and preferences stay attached to one person.

Public commit metadata is a separate choice. **Git co-author credit** defaults on for verified accounts. It adds the verified account's public GitHub noreply address to commits created from shared sessions; OpenClaw never requests or stores a private GitHub email for this feature. Signing in as a different numeric GitHub account resets the choice to that default, so one account cannot inherit another account's explicit opt-out.

When your authenticated profile has prompted a session before an agent run, commits created from that run receive your exact `Co-authored-by` trailer and commits and pull requests visibly credit who worked on the session. Profile participants with verified GitHub identity and Git co-author credit enabled are eligible; remote identities, agents, bots, and the configured primary Git author are excluded. Contributors appear by recorded contribution aggregate, highest first. Ties use the earliest known profile input, with unknown historical times after known times, then immutable GitHub account id. These best-effort aggregates are not exact lifetime prompt counts. Contributions from merged profiles remain attached to their surviving verified account. New participant admission and model-facing credit output are each capped at 32; repair can retain larger histories. The run tells the model when a profile has no enabled credit or history may be incomplete; it never guesses an identity from transcript names.

OpenClaw supplies exact trailers and the ordered contributor list in the model context for that turn and instructs coding agents to retain them through amendments, rebases, and squash commits so credit reaches the final commit merged to the default branch. The Gateway publication broker enforces the same credit directly in its generated commits and pull requests. When the Gateway exposes an external HTTPS session URL, pull requests end with a link to that exact team session. The trailers are not exported through the process or shell environment. Direct Git commands remain ordinary shell execution: OpenClaw does not replace `git` or install repository hooks, so agent instructions and post-commit verification remain their enforcement boundary.

Turning **Git co-author credit** off stops attribution for future runs. It does not rewrite commits that already contain the public trailer.

## GitHub connections

Open **Settings → Profile → GitHub connections** to connect **My GitHub** without changing the shared **System GitHub** account. Both accounts and their connection status remain visible together. Viewing these connections does not require selecting an agent or configuring a default agent. Connecting a credential does not change your verified GitHub sign-in identity, display name, avatar, Git co-author credit preference, or OpenClaw permissions.

My GitHub requires an authenticated, durable Gateway profile, including the local owner profile. An identified operator with `operator.read` can manage only their own connection, even without administrative or general write access. Shared-secret devices using the owner profile share that connection; use per-person sign-in for a team. System and per-agent connection changes still require `operator.admin`.

1. Choose **For me** and connect GitHub. For identified administrators, this is the default purpose; **For the system** is an explicit alternative.
2. Open the displayed `github.com/login/device` link yourself and approve the one-time code. The Gateway verifies the account and keeps the credentials out of browser responses and agent context.
3. Check the connected account before using it. Personal connections use device authorization; the existing PAT alternative remains available for admin-managed shared connections.

### Publish with your account

For an idle session with a reconciled worktree or accepted repository checkpoint, open the compact account arrow beside **Publish PR** to inspect the publisher and account help. The effective shared account remains the default. When only a shared account is available, the popover is informational, with no redundant selector. When multiple accounts are available, choose the publisher in the popover. **My GitHub** always requires explicit selection, even when it is the only available account. If the agent has its own override, the shared account is labeled as an override rather than System.

The account arrow appears only while publication is idle and the account selection is unlocked, before a publication request or result. Pending status, retry actions, confirmation details, errors, and publication results remain inline, not inside the popover.

If the Gateway rejects the selected account before accepting the first publication request, choose **Refresh publication**, review the current account, then explicitly publish again. An unknown outcome keeps the original account and request locked: **Retry publication** checks that same request instead of switching accounts or starting another publication.

Publication state survives navigation between chats, including when an inactive chat pane is unloaded. Split panes showing the same chat share its publication progress and retry. The page retains up to 32 publication attempts within the current authenticated Gateway connection. At capacity, existing retries remain available; complete and review an existing publication, then select **Choose a new publication** before starting another. Read-only operators can **Dismiss** an observed completed result without publishing or confirming anything.

Pending session deletion blocks publication actions without discarding the original request; a failed deletion restores its retry. Confirmed deletion retires the attempt. The page clears this memory on reload or connection changes; profile and session access changes also retire affected attempts.

Publication requires `operator.write` and current access to modify the session; connecting your account alone does not grant either permission.

Personal GitHub is a Gateway-brokered publication connection, not a session-wide shell identity. Ordinary agent `git`/`gh` commands, model-initiated publication, and repository previews and discovery keep their existing credential behavior. OpenClaw cloud workers use the shared execution identity, never your personal connection. For a repository-only session, finish the current turn and wait for its accepted Git-normalized checkpoint; personal publication is available while the worker is idle or after Stop, without a Gateway checkout. Remote sessions sourced from a Gateway worktree still require **Stop cloud worker…** before personal publication. See [`tools.github`](/gateway/config-tools#tools-github) for shared agent execution.

The Gateway binds personal publication to your authenticated profile, the selected account, and the accepted worktree snapshot or repository checkpoint. Another participant's message cannot switch that account or authorize later work using your connection. If the account becomes unavailable or the workspace changes, publication stops with a recovery action instead of falling back to System or native credentials.

After a Gateway restart, unfinished personal publication requires your explicit confirmation before it continues. Confirmation reuses the original request and checks for an already-created commit, pushed branch, or pull request so a lost response does not blindly repeat the action. A changed connection or incompatible workspace requires a new, explicitly selected action. For a repository-only session, confirmation retains the original checkpoint even if later turns have completed; it never silently publishes those later changes.

### Disconnect and reconnect

Disconnecting My GitHub removes its usable local credentials and prevents unfinished personal work from using that connection. Reconnecting creates a new selection, even for the same GitHub account; old requests do not acquire the new authorization automatically. Disconnecting does not rewrite published commits or revoke the application grant on GitHub. Revoke that grant separately in GitHub's application settings when needed.

Personal connections share the Gateway's existing trusted-host boundary. They prevent another participant from using your connection through the personal GitHub API; they do not isolate credentials from administrators or code with unrestricted access to the Gateway OS account. See [Operator scopes](/gateway/operator-scopes) and [Gateway security](/gateway/security).

## Profile appearance preferences

When a Control UI connection is bound to an authenticated Gateway profile, its theme, theme mode, and accent color are stored per profile in the existing `user_preferences` table in the shared state database. Those choices follow that person across devices without changing appearance for other people on the same Gateway.

Profile theme and theme mode preferences override their gateway-wide `ui.prefs` settings and otherwise fall back to the active theme's defaults. The imported custom theme is the exception: its palette lives only in the browser that imported it, so selecting it stays browser-local and never follows the profile. Accent precedence is the profile's `ui.accent` preference, gateway-wide `ui.prefs.accent`, `ui.seamColor`, and finally the active theme's default accent. Restoring a default clears only the profile preference. Owner-profile preferences follow the owner across devices. Connections without a profile keep gateway-wide appearance behavior. Language, chat preferences, and sidebar entries continue using gateway configuration.

## Write directives, not observations

Each entry has a metadata line followed by one imperative directive:

```md
<!-- observed: 2026-07-27 | status: active -->

- Prefer concise progress updates during implementation work.
```

Use these rules:

- Begin with an imperative such as `Always`, `Never`, or `Prefer`.
- Record the date the preference was observed.
- Use only `active` or `superseded` for status.
- Keep one behavioral instruction per directive.
- Store only details that improve assistance. Do not turn the file into a dossier.

PrefEval found that preference following degrades sharply in longer conversations, even with retrieval and prompting ([arXiv:2502.09597](https://arxiv.org/abs/2502.09597)). Restating a stable preference as a directive makes the expected behavior explicit at the point where the agent uses it.

## Supersede in place

When a preference changes, update its existing section. Do not append a second active directive elsewhere in the file.

Before:

```md
<!-- observed: 2026-05-10 | status: active -->

- Prefer detailed explanations for every code change.
```

After:

```md
<!-- observed: 2026-05-10 | status: superseded -->

- Prefer detailed explanations for every code change.

<!-- observed: 2026-07-27 | status: active -->

- Prefer concise implementation summaries unless more detail is requested.
```

Keep the superseded entry next to its replacement so the current directive is unambiguous. HorizonBench reports that systems often select an originally stated preference after the user has changed it ([arXiv:2604.17283](https://arxiv.org/abs/2604.17283)); append-only contradictory history recreates that failure mode.

## Choose the right file

| Information                                                                      | Store it in                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Stable preference or communication style                                         | `USER.md`                                      |
| Relationship or active-project fact that changes how the user should be assisted | `USER.md`                                      |
| Durable non-profile fact, decision, or lesson                                    | `MEMORY.md`                                    |
| Detailed observation or running context                                          | `memory/YYYY-MM-DD.md`                         |
| Event-conditioned future action                                                  | [Standing intents](/concepts/standing-intents) |
| Exact-time or recurring action                                                   | [Scheduled task](/automation/cron-jobs)        |

## Keep it compact

`USER.md` has a deliberately smaller bootstrap budget than general workspace files. When it becomes crowded, remove stale superseded entries and move project detail that does not alter behavior into daily memory or `MEMORY.md`.

## Related

- [Memory overview](/concepts/memory)
- [Standing intents](/concepts/standing-intents)
- [Agent workspace](/concepts/agent-workspace)
