---
title: "Browser automation and exec/sandbox tools - Browser Security, Ssrf, and Remote Control Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Browser Security, Ssrf, and Remote Control Maturity Note

## Summary

Browser security, SSRF, and remote control is Beta. The controls are real:
browser-control auth, strict navigation guards, SSRF policy, remote CDP audit
findings, loopback/CDP reachability policy, and post-action navigation checks.
The score remains Beta because localhost/file/private-network behavior is still
surprising to users, remote CDP is inherently sensitive, and policy exceptions
must be handled with precision.

## Category Scope

This note covers browser-control auth, navigation URL validation, delayed
navigation guards, strict private-network SSRF policy, unsupported protocols,
remote CDP reachability and audit warnings, CDP loopback bypass for OpenClaw's
own control plane, and browser security docs.

## Features

- Browser Security: Covers Browser Security across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- SSRF: Covers SSRF across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- Remote Control: Covers Remote Control across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals:
  - Docs describe browser SSRF policy, loopback/private network handling, remote
    CDP risk, and browser-control exposure.
  - Source enforces navigation checks before and after actions and snapshots.
  - Source audits missing browser-control auth, HTTP remote CDP, and private
    remote CDP hosts.
  - Tests cover navigation guard behavior, existing-session post-action guards,
    loopback auth, remote profile validation, and security audit findings.
- Negative signals:
  - Security behavior is not uniform across managed browser, existing-session,
    remote CDP, and sandbox browser paths.
  - Live archive evidence shows users still hit `browser navigation blocked by
policy` for localhost and file URLs and need clarification.
- Integration gaps:
  - Add a live security matrix for managed, existing-session, remote CDP, and
    sandbox browser that proves localhost, file, private network, and explicit
    allowlist behavior.
  - Add docs examples that pair common local-dashboard workflows with the exact
    SSRF allowlist or safer profile target.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - `browser SSRF remote CDP navigation blocked` returned open issue #67966 for
    Playwright navigation interception in local-managed browser mode.
  - Broader `browser sandbox` search returned issue #84942 about sandbox/browser
    target mismatch, issue #52662 for non-Docker browser sandbox backends, issue
    #64383 about simplifying sandbox browser CDP path, and issue #43803 on
    browser profile hot reload.
- Discrawl reports:
  - `browser navigation blocked policy` returned a 2026-05-11 report where
    public HTTPS passed but `127.0.0.1`, `localhost`, and `file://` failed with
    browser policy/unsupported protocol messages.
  - The same query returned archive discussion of loopback CDP SSRF fixes and
    URL redaction/security review requirements.
- Good qualities:
  - Browser control auth is generated/persisted through gateway auth and can
    fail closed.
  - Navigation checks block unsupported protocols, strict private network access,
    and blocked redirect chains.
  - Remote CDP endpoints are audited for plain HTTP and private/internal hosts.
  - Existing-session interactions re-check current and newly opened tab URLs
    after delayed navigation.
- Bad qualities:
  - The policy is precise but hard to explain: loopback CDP control may be
    allowed while browser navigation to loopback remains blocked.
  - `file://` and localhost/dashboard workflows are common local-dev cases but
    can be rejected by default.
  - Remote CDP is a trusted-control endpoint, and docs must keep reminding users
    not to expose it casually.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Security, SSRF, Remote Control.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The security model needs clearer "why blocked" output for localhost, file,
  remote CDP, and private-network browser destinations.
- Remote CDP security posture should stay under active audit because it is a
  browser-control plane, not normal web browsing.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:216`: browser docs point to SSRF policy handling.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:360`: security docs warn about browser evaluate, private Gateway/node access, remote CDP protection, and strict SSRF examples.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:240`: security docs call out exec approval drift and browser control exposure as review areas.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:1174`: private/internal/special-use browser destinations remain blocked unless explicitly allowed.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md:80`: audit table includes remote CDP over HTTP and private-host findings.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md:89`: audit table includes sandbox browser container non-loopback publish critical finding.

### Source

- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/navigation-guard.ts:10`: only http/https and about:blank URLs are valid browser navigation targets.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/navigation-guard.ts:90`: navigation URL checks block unsupported protocol, proxy-routed strict SSRF, and disallowed hostnames.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/navigation-guard.ts:151`: post-navigation redirect chains are checked.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/control-auth.ts:17`: browser control auth resolves from Gateway auth.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/control-auth.ts:117`: browser control auth can be generated and persisted.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/cdp-reachability-policy.ts:19`: CDP reachability bypasses local loopback only for OpenClaw's own control plane.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/security-audit.ts:68`: browser security audit emits a critical finding when control HTTP routes have no auth.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/security-audit.ts:93`: audit warns when remote CDP uses HTTP.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/security-audit.ts:102`: audit warns when remote CDP targets private/internal hosts under private-network opt-in.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/browser-cdp-snapshot-docker.sh:84`: Docker browser E2E verifies live CDP-based browser operation.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/chrome.loopback-ssrf.integration.test.ts:1`: integration coverage exists for loopback SSRF behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.interactions.navigation-guard.test.ts:73`: verifies post-click navigation guard runs when navigation starts after click.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.interactions.navigation-guard.test.ts:267`: verifies subframe-only private navigation is blocked.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/routes/agent.act.existing-session-navigation-guard.test.ts:131`: verifies existing-session interaction checks navigation after click and key submit.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/routes/agent.act.existing-session-navigation-guard.test.ts:219`: verifies newly opened blocked-tab URLs fail closed.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/profiles-service.test.ts:225`: verifies strict SSRF mode rejects private-network remote CDP.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server.auth-token-gates-http.test.ts:1`: verifies browser HTTP auth token gates.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/security-audit.test.ts:1`: verifies browser security audit findings.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "browser SSRF remote CDP navigation blocked" --json`

Results:

- Open issue #67966: Playwright navigation interception for local-managed browser mode.

Query:

`gitcrawl search openclaw/openclaw --query "browser sandbox" --json`

Results:

- Open issue #84942: sandbox policy reports sandboxed while target=sandbox browser is unavailable.
- Open issue #52662: browser sandbox should support non-Docker backends.
- Open issue #64383: evaluate simplifying sandbox browser CDP path.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "browser navigation blocked policy"`

Results:

- 2026-05-11 clawtributors report: public HTTPS passed, while `127.0.0.1`,
  `localhost`, and `file://` dashboard URLs failed with browser policy or
  unsupported-protocol messages.
- 2026-04-25 OpenClaw archive comments describe loopback CDP SSRF fixes and URL
  redaction/security review requirements for tab URL exposure.
