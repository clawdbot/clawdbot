---
title: "Native Windows companion app - Permissions, Secrets, and Security Posture Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Permissions, Secrets, and Security Posture Maturity Note

## Summary

OpenClaw has core Windows-aware security code for filesystem ACLs, path handling,
Gateway auth, and dangerous node-command gates. The native Windows companion app
does not exist in supported source, so app-specific permissions, secret storage,
signing identity, local IPC trust, and Windows consent flows are undefined.

## Category Scope

- App secrets, token persistence, secure local IPC, app signing identity, AppContainer or desktop permission posture.
- Windows ACL and filesystem hygiene for app-owned state.
- Command approval and dangerous capability gating as surfaced to users.

## Features

- App secrets: App secrets, token persistence, secure local IPC, app signing identity, AppContainer or desktop permission posture
- Windows ACL: Windows ACL and filesystem hygiene for app-owned state
- Command approval: Command approval and dangerous capability gating as surfaced to users

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (5%)`
- Positive signals: core Windows ACL, path, Gateway auth, and command-gating code exists outside the app surface.
- Negative signals: no Windows app secret store, signing identity, permission prompt, secure app IPC, or app approval UI exists in current main.
- Integration gaps: no app security setup, permission prompt, token migration, app IPC authentication, or dangerous command approval scenario can be run.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (28%)`
- Gitcrawl reports: feature-specific `Windows ACL secret path companion app` query returned no hits; broader Windows native app queries show proposals rather than support.
- Discrawl reports: feature-specific `Windows ACL secret path companion app` query returned no messages.
- Good qualities: existing core code fails closed for high-risk node commands and includes Windows ACL/security tests.
- Bad qualities: app-specific security architecture is absent, including app identity, secret storage, local IPC trust, and user-facing permission repair.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (5%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App secrets, Windows ACL, Command approval.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No app signing, trust, secret storage, or local IPC security design exists in supported docs/source.
- No app permission UX exists for screen, camera, location, notifications, or shell execution.
- No documented policy tells operators how to audit an external Windows companion build.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md` mentions Windows ACL resets for filesystem security.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` documents shared exec approval concepts, not a Windows app approval surface.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md` does not define app permissions, signing, or secrets.

### Source

- `/Users/kevinlin/code/openclaw/src/security/windows-acl.ts` implements Windows ACL support.
- `/Users/kevinlin/code/openclaw/src/security/audit-filesystem-windows.test.ts` covers Windows filesystem security cases.
- `/Users/kevinlin/code/openclaw/src/gateway/node-command-policy.ts:64-73` defines dangerous node commands that require explicit allowance.
- No Windows app security or permission source was found.

### Integration tests

- No Windows companion app security integration tests were found.
- Adjacent Windows CLI/Gateway smoke exists outside this component.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/security/windows-acl.test.ts`
- `/Users/kevinlin/code/openclaw/src/security/audit-filesystem-windows.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-misc.test.ts`
- No app-specific Windows permission or secret tests were found.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows ACL secret path companion app" --json`
- `gitcrawl search openclaw/openclaw --query "native Windows app" --json`

Results:

- Feature-specific ACL/secret query returned no hits.
- Broader query surfaced `#12505`, a sandbox feature request mentioning future platform-native Windows sandbox/AppContainer work, plus unrelated Windows mentions.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows ACL secret path companion app"`

Results:

- No messages.
