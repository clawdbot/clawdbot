// Intentional Knip unused-file findings. These are dynamic entrypoints,
// generated/build inputs, manifest-discovered plugin surfaces, live-test
// helpers, or package bridge files that static production scanning cannot see.
export const KNIP_UNUSED_FILE_ALLOWLIST = [
  // Per-agent SQLite scaffold is intentionally ahead of mainline runtime callers.
  // The pending SQLite session/runtime branch wires these files into production.
  "src/agents/cache/agent-cache-store.sqlite.ts",
  "src/agents/cache/agent-cache-store.ts",
];

// Knip can disagree across supported local/CI platforms for files that are
// only reachable through test-only import graphs, sparse-checkout proof
// workspaces, dynamic entrypoints, manifest-discovered plugin surfaces, or
// package bridge files. Ignore these when reported, but do not require them
// to be reported.
export const KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST = [
  "extensions/acpx/src/runtime-internals/mcp-command-line.mjs",
  "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
  "extensions/canvas/src/host/a2ui-app/bootstrap.js",
  "extensions/canvas/src/host/a2ui-app/rolldown.config.mjs",
  "extensions/copilot/src/doctor-probes.ts",
  "extensions/copilot/src/telemetry-bridge.ts",
  "extensions/copilot/src/user-input-bridge.ts",
  "extensions/diffs/src/viewer-client.ts",
  "extensions/diffs/src/viewer-payload.ts",
  "extensions/matrix/src/plugin-entry.runtime.js",
  "extensions/memory-core/src/memory-tool-manager-mock.ts",
  "ui/src/ui/browser-redact.ts",
  "src/agents/subagent-registry.runtime.ts",
  "src/auto-reply/inbound.group-require-mention-test-plugins.ts",
  "src/auto-reply/reply/get-reply.test-loader.ts",
  "src/cli/daemon-cli-compat.ts",
  "src/commands/doctor/shared/deprecation-compat.ts",
  "src/config/doc-baseline.runtime.ts",
  "src/config/doc-baseline.ts",
  "src/gateway/gateway-cli-backend.live-helpers.ts",
  "src/gateway/gateway-cli-backend.live-probe-helpers.ts",
  "src/gateway/gateway-codex-harness.live-helpers.ts",
  "src/mcp/openclaw-tools-serve.ts",
  "src/mcp/plugin-tools-handlers.ts",
  "src/mcp/plugin-tools-serve.ts",
  "src/mcp/tools-stdio-server.ts",
  "src/plugins/build-smoke-entry.ts",
  "src/plugins/contracts/host-hook-fixture.ts",
  "src/plugins/contracts/rootdir-boundary-canary.ts",
  "src/plugins/contracts/tts-contract-suites.ts",
  "src/plugins/runtime-sidecar-paths-baseline.ts",
  "src/tasks/task-registry-control.runtime.ts",
  "ui/src/ui/browser-redact.ts",
  "extensions/qa-lab/src/auth-profile.fixture.ts",
  "extensions/qa-lab/src/codex-plugin.fixture.ts",
];
