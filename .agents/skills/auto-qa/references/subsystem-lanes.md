# Current-source subsystem lanes

Freeze `origin/main` before starting a wave. Let only the orchestrator update the shared remote ref; pause refreshes during native PR preparation and merge. Fetch again after landing, verify that the fetched baseline contains the canonical merge commit, and give each resumed worker that final frozen SHA. Inspect root and scoped `AGENTS.md`, owner boundaries, tests, callers, sibling implementations, package scripts, and current GitHub history. File locations are discovery starting points, not a claim that a particular file, scenario ID, route, or model still exists.

Maintain at least ten distinct active investigations. Split any large area into smaller leaf tasks:

1. **CLI setup and repair:** `src/cli`, `src/commands`, onboarding, noninteractive setup, doctor, current configuration, and shipped upgrade behavior.
2. **Gateway HTTP:** `src/gateway`, current health/readiness, route ownership, authentication, OpenAI-compatible requests, error responses, and streaming.
3. **Gateway transport:** current WebSocket protocol, connection scopes, subscriptions, reconnect, cancellation, timeouts, and event delivery.
4. **OpenAI provider:** provider-owned discovery, canonical `openai/*` model references, credential resolution, tool schemas, file/image input, and real streamed responses.
5. **Plugin lifecycle:** `src/plugins`, `extensions`, install records, current manifest and catalog behavior, packaged Git/npm installs, update, uninstall, and restart boundaries.
6. **Control UI:** `ui`, built assets, gateway connection, navigation, browser errors, settings, session rendering, and reconnect. Use the actual Control UI E2E workflow.
7. **QA Lab:** `qa/scenarios/index.yaml`, current scenario YAML, `extensions/qa-lab`, `extensions/qa-channel`, provider mode, nonzero scenario counts, timeouts, and artifacts.
8. **Agent sessions:** `src/agents`, transcript ordering, tool execution, model routing, compaction, abort, session state, isolated spawning, and parent/child completion.
9. **Schedulers and delivery:** current cron/scheduler ownership, timers, deduplication, retries, channel targets, lifecycle, and observable delivery.
10. **Native and portability:** `apps`, current macOS, iOS and Android prerequisites, signing, simulator/device availability, Linux/Windows paths, and hosted CI coverage.
11. **Channel adapters:** `src/channels` and transport-owner plugins, native callback envelopes, mentions, media limits, thread targets, and actual available test credentials.
12. **Packaging and distribution:** package manifests, dist exports, generated artifacts, installer commands, Docker, bundled plugin ownership, and actual install/update flows.

Additional lanes may cover context assembly, memory, SDK consumers, browser automation, media, Matrix, observability, or compatibility. Do not manufacture findings by dividing one defect into multiple lanes.

Give read-only Codex CLI reviewers a narrow prompt equivalent to:

> At frozen OpenClaw main `<full-sha>`, independently audit `<single ownership surface>` for real correctness regressions. Read the complete root and relevant scoped guides, complete changed modules, entry point, callers, callees, sibling paths, state lifecycle, tests, and direct dependency source where relevant. Do not modify files, execute heavy tests, access or print secrets, alter an operator gateway, invoke a remote lease, or assume another reviewer's conclusion. Return only concrete current-main defects with repo-root paths, user-path reproduction, canonical root cause, all affected siblings, a coherent owner-boundary refactor, authentic regression, duplicates, and low-risk versus user-review classification. Reject symptom-only patches and count a shared invariant once. Explicitly return no verified bug if the evidence is insufficient.

Use the current installed CLI and verify its supported flags with `codex exec --help`. Keep reviews ephemeral and bounded. Set a read-only sandbox for reviewers; reserve writable isolated worktrees for authorized fixers. When an offline, no-network, or no-independent-worker assignment forbids starting Codex CLI reviewers, inspect the subsystem slices directly and explicitly report that simultaneous independent lane capacity is unavailable.
