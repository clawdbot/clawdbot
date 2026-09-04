import { fileURLToPath } from "node:url";
import { qaGatewayCleanupRuntimeEntrypoint } from "../../extensions/qa-lab/src/gateway-child-artifacts-runtime.test-support.ts";
import {
  codeModeDescriptionRetentionEntrypoint,
  codeModeRetentionEntrypoint,
} from "../../src/agents/code-mode-retention-entrypoint.test-support.ts";
import { cliCompactionBackendEntrypoints } from "../../src/agents/command/cli-compaction-runtime.test-support.ts";
import { cliRecoveryEntrypoints } from "../../src/cli/cli-entrypoint.test-support.ts";
import { cronOwnerHardeningEntrypoints } from "../../src/cron/owner-hardening-runtime.test-support.ts";
import { sessionListCacheRetentionEntrypoint } from "../../src/gateway/server-methods/sessions-list-cache-retention-entrypoint.test-support.ts";
import { sessionChildCacheRetentionEntrypoint } from "../../src/gateway/session-child-cache-retention-entrypoint.test-support.ts";
import { sessionTitleRetentionEntrypoints } from "../../src/gateway/session-title-retention.test-support.ts";
import { nodeHostConfigRuntimeEntrypoint } from "../../src/node-host/config-runtime.test-support.ts";
import { persistenceRuntimeEntrypoint } from "../../src/skills/library/persistence-runtime.test-support.ts";
import { stateLeaseProcessExitRuntimeEntrypoint } from "../../src/state/openclaw-state-lease-runtime.test-support.ts";
import { tuiPtyRuntimeEntrypoints } from "../../src/tui/tui-pty-runtime-test-support.ts";
import { channelIngressGatewayRestartEntrypoint } from "../../test/fixtures/channel-ingress-gateway-restart-entrypoint.ts";
import { runtimeProcessBuildEntries } from "./runtime-process-build-entries.mts";

// Test-only roots share the invocation generation without changing package entries.
export const vitestWorkerBuildEntries = {
  ...runtimeProcessBuildEntries,
  ...Object.fromEntries(
    [
      codeModeRetentionEntrypoint,
      codeModeDescriptionRetentionEntrypoint,
      ...cliCompactionBackendEntrypoints,
      ...Object.values(cliRecoveryEntrypoints),
      ...Object.values(cronOwnerHardeningEntrypoints),
      ...Object.values(tuiPtyRuntimeEntrypoints),
      ...Object.values(sessionTitleRetentionEntrypoints),
      sessionListCacheRetentionEntrypoint,
      sessionChildCacheRetentionEntrypoint,
      nodeHostConfigRuntimeEntrypoint,
      channelIngressGatewayRestartEntrypoint,
      persistenceRuntimeEntrypoint,
      qaGatewayCleanupRuntimeEntrypoint,
      stateLeaseProcessExitRuntimeEntrypoint,
    ].map((entry) => [
      entry.distWorkerPath.replace(/\.js$/u, ""),
      fileURLToPath(new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl)),
    ]),
  ),
  // The retention fixture executes the real nested QuickJS worker.
  "agents/code-mode.worker": "src/agents/code-mode.worker.ts",
  // The real ulimit fixture must import its parent before imposing a file-size limit.
  "infra/sqlite-readonly-location": "src/infra/sqlite-readonly-location.ts",
  // Keep provider preparation in the same compiled graph as payload rendering;
  // a source-injected plugin would miss duplicated registry scope state.
  "plugins/provider-hook-runtime": "src/plugins/provider-hook-runtime.ts",
  // Real provider preparation uses packaged JavaScript, avoiding per-child source transforms.
  "extensions/anthropic/index": "extensions/anthropic/index.ts",
  "test-support/anthropic-preparation": "test/scripts/anthropic-preparation-probe.ts",
  // Exercise native writes through the existing plugin facade in the private graph.
  "plugin-sdk/file-access-runtime": "src/plugin-sdk/file-access-runtime.ts",
};
