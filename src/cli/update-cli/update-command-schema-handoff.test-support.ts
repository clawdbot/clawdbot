import fs from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { FinishUpdateParams } from "./update-command-post-update.js";

const root = process.env.OPENCLAW_HOME!;
const child = process.env.OPENCLAW_UPDATE_POST_CORE === "finalize";
const scenario = process.env.HANDOFF_SCENARIO!;
const reportPath = path.join(root, "parent-report.json");
const entrypoint = path.join(root, "updated.mjs");
const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
const schemaUrl = sourceUrl("../../state/openclaw-state-db-contract.ts");
const contractSource = fs.readFileSync(new URL(schemaUrl), "utf8");
const currentSchema = Number(/OPENCLAW_STATE_SCHEMA_VERSION = (\d+)/u.exec(contractSource)![1]);
const nextSchema = currentSchema + 1;
const snapshot: FinishUpdateParams["configSnapshot"] = {
  path: path.join(root, "openclaw.json"),
  exists: true,
  raw: null,
  valid: true,
  config: { plugins: { enabled: false } },
  runtimeConfig: { plugins: { enabled: false } },
  sourceConfig: { plugins: { enabled: false } },
  resolved: { plugins: { enabled: false } },
  parsed: { plugins: { enabled: false } },
  issues: [],
  warnings: [],
  legacyIssues: [],
};
const pluginUpdate = {
  status: "ok",
  changed: false,
  warnings: [],
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
const stubs = new Map<string, string>();
function override(relative: string, source: string) {
  const url = sourceUrl(relative);
  stubs.set(url, `export * from ${JSON.stringify(`${url}?actual`)};\n${source}`);
}
override(
  "../../daemon/gateway-entrypoint.ts",
  `export const resolveGatewayInstallEntrypoint = async () => ${JSON.stringify(entrypoint)};`,
);
override(
  "./shared.ts",
  `export const resolveUpdateRoot = async () => ${JSON.stringify(root)}; export const tryWriteCompletionCache = async () => {};`,
);
override(
  "../../config/config.ts",
  `export const readConfigFileSnapshot = async () => (${JSON.stringify(snapshot)});`,
);
override(
  "../../plugins/plugin-lifecycle-lease.ts",
  "export const withPluginLifecycleLease = async (_options, run) => run();",
);
override(
  "../../plugins/installed-plugin-index-records.ts",
  "export const loadInstalledPluginIndexInstallRecords = async () => ({});",
);
override(
  "./update-command-config.ts",
  "export const persistRequestedUpdateChannel = async ({configSnapshot}) => configSnapshot; export const restoreDroppedPreUpdateChannels = snapshot => ({snapshot, changed:false});",
);
override(
  "./update-command-plugins.ts",
  `export const updatePluginsAfterCoreUpdate = async () => (${JSON.stringify(pluginUpdate)});`,
);
override(
  "./update-command-post-core.ts",
  `export const continuePostCoreUpdateInFreshProcess = async () => ({resumed:true, pluginUpdate:${JSON.stringify(pluginUpdate)}});`,
);
override(
  "../../infra/update-triage.ts",
  "export const prepareUpdateFailureTriage = async () => async () => {};",
);
override(
  "./update-command-service.ts",
  `
export const resolveUpdatedGatewayRestartPort = async () => 19091;
export const maybeRestartService = async () => true;
export const tryInstallShellCompletion = async () => {};
`,
);
override(
  "./update-command-fresh-doctor.ts",
  `
import { DatabaseSync } from 'node:sqlite';
import { resolveOpenClawStateSqlitePath } from ${JSON.stringify(sourceUrl("../../state/openclaw-state-db.paths.ts"))};
export async function runUpdateFinalizationDoctorInFreshProcess() {
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath(process.env));
  try { db.exec('PRAGMA user_version = ${nextSchema}; UPDATE schema_meta SET schema_version = ${nextSchema}'); } finally { db.close(); }
  // Keep the real parent's 250ms observer alive across the migration.
  await new Promise(resolve => setTimeout(resolve, 350));
  ${scenario === "doctor-error" ? "throw new Error('Synthetic Doctor failure after migration');" : ""}
}
export const completePostCorePluginUpdate = async ({pluginUpdate}) => ({pluginUpdate, configSnapshot:${JSON.stringify(snapshot)}});
`,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!url.search) {
        const replacement = stubs.get(url.href.replace(/\.js$/u, ".ts"));
        if (replacement) {
          return {
            url: `data:text/javascript,${encodeURIComponent(replacement)}`,
            shortCircuit: true,
          };
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (child && url === schemaUrl) {
      return {
        format: "module",
        source: stripTypeScriptTypes(
          contractSource.replace(
            `OPENCLAW_STATE_SCHEMA_VERSION = ${currentSchema}`,
            `OPENCLAW_STATE_SCHEMA_VERSION = ${nextSchema}`,
          ),
        ),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { continueUpdateFinalizationInFreshProcess, resumeUpdateFinalization } =
  await import("./update-command-schema-handoff.js");
if (child) {
  try {
    await resumeUpdateFinalization();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else {
  const require = createRequire(import.meta.url);
  fs.writeFileSync(
    entrypoint,
    `import { register } from ${JSON.stringify(pathToFileURL(require.resolve("tsx/esm/api")).href)}; register({tsconfig:${JSON.stringify(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)))}}); await import(${JSON.stringify(import.meta.url)});\n`,
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", version: "2026.9.2" }),
  );
  const { createUpdateRun } = await import("../../infra/update-run-ledger.js");
  const { createUpdateProgress } = await import("./progress.js");
  const { closeOpenClawStateDatabaseForTest } = await import("../../state/openclaw-state-db.js");
  const run = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: process.env,
    transferred: false,
  };
  const progress = createUpdateProgress(true, run);
  const recoveryEvents: Array<{ event: string; safe: boolean }> = [];
  const params: FinishUpdateParams = {
    root,
    result: {
      status: "ok",
      mode: "git",
      root,
      before: { sha: "before", version: "2026.9.2" },
      after: { sha: "after", version: "2026.9.2" },
      deferredDoctor: true,
      steps: [],
      durationMs: 0,
    },
    installKindChanged: false,
    configSnapshot: snapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: "dev",
    downgradeRisk: false,
    shouldRestart: false,
    opts: { yes: true, json: true, run },
    preManagedServiceStop: {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceMutationAllowed: false,
      windowsTaskAutoStartRecovery: {
        beginMutation: () => {},
        interrupted: () => false,
        restore: async (safe = false) => {
          recoveryEvents.push({ event: "restore", safe });
        },
        complete: (safe = true) => {
          recoveryEvents.push({ event: "complete", safe });
        },
      },
    },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    packageUpdateNodeRunner: process.execPath,
    updateStepTimeoutMs: 30_000,
  };
  let outcome = "ok";
  try {
    await continueUpdateFinalizationInFreshProcess(params);
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
  } finally {
    progress.dispose();
    closeOpenClawStateDatabaseForTest();
  }
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      outcome,
      runId: run.runId,
      transferred: run.transferred,
      recoveryEvents,
      currentSchema,
      nextSchema,
    }),
  );
}
