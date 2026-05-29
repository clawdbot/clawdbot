# GitHub Copilot agent runtime (OpenClaw plugin)

Bundled OpenClaw plugin that registers a `copilot` agent harness backed
by `@github/copilot-sdk` and the GitHub Copilot CLI.

The harness claims the canonical subscription `github-copilot` provider and
is opt-in only — selection requires explicit `agentRuntime.id: "copilot"`
on a model or provider entry; `auto` never picks it. PI remains the default
embedded runtime.

See [GitHub Copilot agent runtime](../../docs/plugins/copilot.md) for
configuration, doctor probes, transcript mirroring, compaction, side
questions, replay, and the supported-surface contract.
See [qa/copilot-capabilities.md](../../qa/copilot-capabilities.md)
for the SDK capability inventory the harness is pinned to.
