---
title: "Google Chat - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Channel Setup and Operations Maturity Note

## Summary

Google Chat setup is documented and wired through the plugin setup surface, but it remains an Alpha operator experience because a successful install depends on Google Cloud project state, Chat API enablement, service account JSON, public HTTPS routing, Google Chat app visibility, webhook audience matching, and sometimes the numeric add-on principal. The docs explain the happy path, but archive evidence shows users still spend hours on appPrincipal, 401, and space setup issues.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Operations`, `Webhook Auth`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Google Cloud project setup: Covers Google Cloud project setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Chat app configuration: Covers Chat app configuration across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Service account setup: Covers Service account setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Webhook audience and path: Covers Webhook audience and path across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Workspace visibility and app status: Covers Workspace visibility and app status across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Guided channel setup: Covers Guided channel setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Account resolution: Covers Account resolution across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Service account SecretRefs: Covers Service account SecretRefs across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Env file and inline credentials: Covers Env file and inline credentials across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Channel status and probes: Covers Channel status and probes across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Directory and mutable-id diagnostics: Covers Directory and mutable-id diagnostics across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- NPM and ClawHub install: Covers NPM and ClawHub install across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Plugin docs and catalog routing: Covers Plugin docs and catalog routing across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Channel aliases and labels: Covers Channel aliases and labels across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Operator status UI: Covers Operator status UI across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Install/update metadata: Covers Install/update metadata across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Webhook path handling: Covers Webhook path handling across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Standard Chat token verification: Covers Standard Chat token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Workspace add-on token verification: Covers Workspace add-on token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Audience and appPrincipal validation: Covers Audience and appPrincipal binding across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Shared-path target selection: Covers Shared-path target selection across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Auth rejection diagnostics: Covers Auth rejection diagnostics across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Account resolution: Covers Account resolution across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior
- Service account SecretRefs: Covers Service account SecretRefs across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior
- Env file and inline credentials: Covers Env file and inline credentials across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior
- Channel status and probes: Covers Channel status and probes across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior
- Directory and mutable-id diagnostics: Covers Directory and mutable-id diagnostics across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior
- NPM and ClawHub install: Covers NPM and ClawHub install across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior
- Plugin docs and catalog routing: Covers Plugin docs and catalog routing across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior
- Channel aliases and labels: Covers Channel aliases and labels across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior
- Operator status UI: Covers Operator status UI across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior
- Install/update metadata: Covers Install/update metadata across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior
- Webhook path handling: Covers Webhook path handling across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior
- Standard Chat token verification: Covers Standard Chat token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior
- Workspace add-on token verification: Covers Workspace add-on token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior
- Audience and appPrincipal binding: Covers Audience and appPrincipal binding across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior
- Shared-path target selection: Covers Shared-path target selection across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior
- Auth rejection diagnostics: Covers Auth rejection diagnostics across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior

## Features

- Google Cloud project setup: Covers Google Cloud project setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Chat app configuration: Covers Chat app configuration across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Service account setup: Covers Service account setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Webhook audience and path: Covers Webhook audience and path across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Workspace visibility and app status: Covers Workspace visibility and app status across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Guided channel setup: Covers Guided channel setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Account resolution: Covers Account resolution across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Service account SecretRefs: Covers Service account SecretRefs across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Env file and inline credentials: Covers Env file and inline credentials across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Channel status and probes: Covers Channel status and probes across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Directory and mutable-id diagnostics: Covers Directory and mutable-id diagnostics across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- NPM and ClawHub install: Covers NPM and ClawHub install across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Plugin docs and catalog routing: Covers Plugin docs and catalog routing across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Channel aliases and labels: Covers Channel aliases and labels across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Operator status UI: Covers Operator status UI across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Install/update metadata: Covers Install/update metadata across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: The setup surface is not only prose. The plugin metadata exposes `@openclaw/googlechat`, channel aliases, docs path, CLI add options for webhook path/audience fields, env var names, setup entrypoints, and an interactive setup wizard. Unit tests cover setup input validation, account patching, environment credential selection, account-scoped DM policy writes, webhook path startup, account merge behavior, and service-account file validation.
- Negative signals: I found no dedicated Google Chat live/e2e QA lane comparable to Discord or Slack. Coverage is therefore mostly local setup/config contract proof, not a fresh end-to-end run through Google Cloud Console, Workspace app visibility, public webhook exposure, gateway restart, and real Google Chat DM/space delivery.
- Integration gaps: Add a gated live setup scenario that starts from a minimal config, installs the plugin, verifies the service account file/env path, validates `audienceType`/`audience`/`appPrincipal`, starts the gateway, receives a real Google Chat webhook, and confirms `openclaw channels status --probe` reports actionable setup state.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: The Google Chat issue set includes open setup-adjacent failures such as #58514 for space messages silently ignored while DMs work and #65007 for add-on payload and wildcard group allowlist mismatches. Closed but recent setup/auth issues #53888, #57542, #67786, #35095, and #71078 show that appPrincipal/JWT `sub` requirements and silent 401 loops were real operator traps.
- Discrawl reports: `discrawl search "Google Chat setup service account audience" --limit 10` returned setup guidance that service account JSON plus `audienceType: "app-url"` and public webhook URL are the core Workspace story. It also returned repeated 2026-04 discussions about `appPrincipal` needing the JWT `sub`, not the service-account email, and a review warning that requiring `appPrincipal` without updating guided setup would break channel configuration.
- Good qualities: The channel doc gives a beginner setup path, public URL recipes for Tailscale Funnel, Caddy, and Cloudflare Tunnel, target formats, pairing, config highlights, and troubleshooting. Source keeps service account credential resolution localized, supports file/inline/env credentials, supports per-account shared defaults, and validates Google service-account endpoint fields before passing credentials into google-auth.
- Bad qualities: The setup contract crosses too many external admin surfaces for the current UX. App visibility, webhook URL reachability, add-on versus standard Chat payloads, numeric `appPrincipal`, and Google Cloud console status are easy to misconfigure. Some of those risks are now warned about, but the docs and setup wizard still do not make every required Google-side value self-discovering.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Google Cloud project setup, Chat app configuration, Service account setup, Webhook audience and path, Workspace visibility and app status, Guided channel setup, Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics, NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Extend guided setup to capture or explain `appPrincipal` when `audienceType` is `app-url` and the app uses add-on tokens.
- Add an operator checklist that distinguishes standard Chat issuer tokens from Workspace add-on tokens and explains which fields are required for each.
- Add one live setup proof that exercises the documented Google Cloud and Google Chat app flow against a real private Workspace app.
- Make plugin activation, service account credential source, webhook URL, and audience mismatch diagnostics visible from the same setup/status path.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents install, beginner Google Cloud setup, service-account JSON, Google Chat app configuration, app visibility, public HTTPS webhook exposure, `audienceType`, `audience`, `webhookPath`, `serviceAccountFile`, `serviceAccountRef`, target formats, pairing, config highlights, and 405/plugin-disabled troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/googlechat.md`: identifies the plugin as `@openclaw/googlechat`, distributed through npm and ClawHub, with channel surface `googlechat`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md`: includes the Google Chat channel config block and mutable-name-matching warning.
- `/Users/kevinlin/code/openclaw/docs/start/wizard-cli-reference.md`: lists Google Chat as a wizard-supported channel using service-account JSON plus webhook audience.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/package.json`: declares package metadata, CLI add options for `--webhook-path`, `--webhook-url`, `--audience-type`, and `--audience`, npm/ClawHub install metadata, and host compatibility.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/openclaw.plugin.json`: declares channel id `googlechat`, startup behavior, and env vars `GOOGLE_CHAT_SERVICE_ACCOUNT` and `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup-core.ts`: builds account config patches from token/token-file/audience/webhook setup inputs and validates that non-env setup includes service-account JSON or file.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup-surface.ts`: implements the interactive setup wizard, env credential detection, service-account file/inline prompts, audience prompt, and DM policy setup.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/accounts.ts`: resolves merged account config, default-account env fallback, inline/file credential sources, and per-account shared defaults.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/google-auth.runtime.ts`: validates service-account credential shape and trusted Google auth endpoints, limits credential file size, supports symlinked secret mounts, and uses an SSRF-guarded google-auth transport.

### Integration tests

- No dedicated Google Chat live/e2e setup lane was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-build-entries.test.ts`: includes Google Chat in bundled/external plugin build-entry checks.
- `/Users/kevinlin/code/openclaw/src/plugins/official-external-plugin-catalog.test.ts`: asserts the official external plugin catalog resolves `googlechat` to `@openclaw/googlechat`.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup.test.ts`: covers setup adapter validation, config patching, wizard prompts, status, DM policy path resolution, monitor startup, env credential fallback, and multi-account config inheritance.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/google-auth.runtime.test.ts`: covers guarded auth fetches, proxy/mTLS behavior, response limits, isolated transports, header normalization, service-account endpoint validation, symlinked files, and redacted file-read errors.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/config-schema.test.ts`: covers Google Chat config schema defaults and validation.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat" --repo openclaw/openclaw --limit 20 --json number,title,state,updatedAt,url`

Results:

- Returned open Google Chat issues #65007, #80995, #82014, #44347, #49350, #77307, #58514, #42510, #9764, #69422, and #39843, showing the channel has active setup/runtime risk.

Query:

`gitcrawl gh issue view 53888 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned closed #53888, `Google Chat: silent webhook auth failures + undocumented appPrincipal requirement`, updated 2026-04-28. It was treated as recent setup-auth confusion now partly addressed, not an open blocker.

Query:

`gitcrawl gh issue view 57542 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned closed #57542, `Google Chat app-url auth requires appPrincipal = JWT sub, but this is undocumented and auth failures are silent`, updated 2026-04-28.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat setup service account audience" --limit 10`

Results:

- Returned Workspace setup guidance describing service-account JSON, `audienceType: "app-url"`, and the public `/googlechat` webhook URL as the main Google Chat app path.
- Returned 2026-04 issue comments and review discussion explaining that `appPrincipal` must be the JWT `sub` numeric value, not the service-account email, and that setup flow changes are needed before making it mandatory.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat appPrincipal" --limit 10`

Results:

- Returned #35095/#67786/#57542/#71078 discussion that auth rejection logging and startup warnings now help, but that the appPrincipal contract was a recurring operator failure mode.
