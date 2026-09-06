import { asResolvedSourceConfig, asRuntimeConfig } from "../config/materialize.js";
// Exercise the real result producer and CLI output owner over a child-process pipe.
import { defaultRuntime } from "../runtime.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";
import { finishUpdate } from "./update-cli/update-command-post-update.js";
import { withUpdateFailureTriage } from "./update-cli/update-command-triage.js";

await runCliWithExitFinalization({
  run: async () => {
    const root = process.env.OPENCLAW_STATE_DIR!;
    await withUpdateFailureTriage(
      { json: true, invocationCwd: root },
      { root, env: process.env },
      async () => {
        await finishUpdate({
          result: {
            status: "error",
            mode: "git",
            root,
            reason: "doctor-failed",
            recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
            steps: Array.from({ length: 40 }, (_, index) => ({
              name: `update step ${index}`,
              command: "fixture",
              cwd: root,
              durationMs: 1,
              exitCode: index === 39 ? 1 : 0,
              stderrTail: "diagnostic ".repeat(727),
            })),
            durationMs: 1,
          },
          root,
          installKindChanged: false,
          configSnapshot: {
            path: process.env.OPENCLAW_CONFIG_PATH!,
            exists: false,
            raw: null,
            parsed: {},
            resolved: asResolvedSourceConfig({}),
            valid: true,
            runtimeConfig: asRuntimeConfig({}),
            config: asRuntimeConfig({}),
            sourceConfig: asResolvedSourceConfig({}),
            issues: [],
            warnings: [],
            legacyIssues: [],
          },
          requestedChannel: null,
          storedChannel: null,
          channel: "dev",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true },
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 1_000,
        });
      },
    );
  },
  onError: (error) => {
    defaultRuntime.error(String(error));
    process.exitCode = 1;
  },
});
