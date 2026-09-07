// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { formatDoctorStateRepairFailure } from "../infra/state-repair-message.js";
import {
  captureUpdateDoctorConfigWrites,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

async function assertDoctorDatabaseSchemasCompatible(scope?: "state") {
  const [databasePreflight, agentDatabase, stateDatabase] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("../state/openclaw-agent-db-contract.js"),
    import("../state/openclaw-state-db-contract.js"),
  ]);
  const [{ createConfigIO }, targets] = await Promise.all([
    import("../config/io.js"),
    import("../config/sessions/targets.js"),
  ]);
  const snapshot = await createConfigIO({
    env: { ...process.env },
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const cfg = snapshot.sourceConfig ?? snapshot.config;
  const databaseSchemas = await databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
    scope,
    configuredAgentDatabaseTargets: (registeredDatabases) =>
      targets.resolveConfiguredAgentDatabaseTargets(cfg, { env: process.env, registeredDatabases }),
    configuredAgentDatabaseCandidatePaths: targets.resolveConfiguredAgentDatabaseCandidatePaths(
      cfg,
      { env: process.env },
    ),
    supportedVersions: {
      state: stateDatabase.OPENCLAW_STATE_SCHEMA_VERSION,
      agent: agentDatabase.OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  });
  if (databaseSchemas.incompatible.length > 0) {
    throw new databasePreflight.OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadableStateDatabase = databaseSchemas.indeterminate.find(
    (database) => database.kind === "state",
  );
  if (unreadableStateDatabase) {
    throw new Error(
      formatDoctorStateRepairFailure(
        `shared state database is unreadable at ${unreadableStateDatabase.path}: ${unreadableStateDatabase.reason}`,
        "Stop OpenClaw processes, then restore this file from a verified backup; the unreadable database was left unchanged.",
      ),
    );
  }
  return databaseSchemas;
}

function stateDirectoryExistsAtDoctorStart(): boolean {
  try {
    return fs.statSync(resolveStateDir()).isDirectory();
  } catch {
    return false;
  }
}

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function runDoctorHealthFlow(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  return resultPath
    ? captureUpdateDoctorConfigWrites(resolveConfigPath(), (capture) =>
        runDoctorHealthFlowWithResult(runtime, options, { resultPath, capture }),
      )
    : runDoctorHealthFlowWithResult(runtime, options);
}

async function runDoctorHealthFlowWithResult(
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  updateResult?: { resultPath: string; capture: { hash: string; inputHash?: string } },
) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  // Config loading can initialize SQLite-backed state before integrity runs.
  // Preserve the entry fact so doctor can report that automatic initialization.
  const stateDirExistedAtStart = stateDirectoryExistsAtDoctorStart();
  intro("OpenClaw doctor");

  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (options.repair === true || options.yes === true || options.generateGatewayToken === true) {
    const { assertConfigWriteAllowedInCurrentMode } =
      await import("../config/nix-mode-write-guard.js");
    assertConfigWriteAllowedInCurrentMode();
  }
  let maintenance: Awaited<
    ReturnType<typeof import("../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let exitCode: number | undefined;
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  try {
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    maintenance = await beginDoctorMaintenance({ options, root, runtime: effectiveRuntime });
    const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
    const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
    // Explicit repair never offers an update. Acquire its owners before any
    // snapshot; diagnostic Doctor still checks state before update admission.
    if (!maintenance) {
      await assertDoctorDatabaseSchemasCompatible("state");
      const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
      const offeredUpdate = await maybeOfferUpdateBeforeDoctor({
        runtime: effectiveRuntime,
        options,
        root,
        confirm: (p) => prompter.confirm(p),
        outro,
      });
      if (offeredUpdate.handled) {
        return;
      }
    }
    const schemas = await assertDoctorDatabaseSchemasCompatible();
    const { guardUpdateDoctorSchemaUpgrade } =
      await import("../commands/doctor-update-schema-guard.js");
    await guardUpdateDoctorSchemaUpgrade({
      schemas,
      runtime: effectiveRuntime,
      json: options.json,
    });

    // Keep side-effect-heavy legacy checks before structured contributions until fully migrated.
    const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
    const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
    const { noteStalePluginRuntimeSymlinks } =
      await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
    const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
    await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
    noteSourceInstallIssues(root);
    await noteStalePluginRuntimeSymlinks(root);
    noteStartupOptimizationHints();

    const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options,
      confirm: (p) => prompter.confirm(p),
      runtime: effectiveRuntime,
      prompter,
    });
    const { CONFIG_PATH } = await loadConfigModule();
    const ctx: DoctorHealthFlowContext = {
      runtime: effectiveRuntime,
      options,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid ?? true,
      configPath: configResult.path ?? CONFIG_PATH,
      stateDirExistedAtStart,
      gatewayMaintenanceActive: maintenance !== undefined,
      runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
    };
    const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
    await runDoctorHealthContributions(ctx);
    if (ctx.configWriteRefusal) {
      // Config fixes were computed but refused by the writer; the warning above
      // already lists the manual work. This failure outranks a recoverable
      // post-install advisory because the run did not converge.
      outro(
        ctx.configResultWriteCommitted === true
          ? "Doctor finished, but some config fixes were not applied."
          : "Doctor finished, but config fixes were not applied.",
      );
      exitCode = 1;
      return;
    }
    if (options.repair === true || options.yes === true) {
      // Contributions can report optional migration warnings, but repair must not
      // complete while required state still blocks runtime access.
      const { assertSessionStoreMigrationComplete } =
        await import("../config/sessions/startup-migration.js");
      assertSessionStoreMigrationComplete({ cfg: ctx.cfg, env: process.env, operation: "doctor" });
      const { assertOpenClawDatabasesReady } =
        await import("../state/openclaw-database-preflight.js");
      const { resolveConfiguredAgentDatabaseTargets } =
        await import("../config/sessions/targets.js");
      await assertOpenClawDatabasesReady({
        env: process.env,
        operation: "doctor",
        onDeferredSchemaPublication: (publication) => effectiveRuntime.log(publication.message),
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(ctx.cfg, {
          env: process.env,
        }),
      });
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      assertConfiguredWorkspaceStateReady({ cfg: ctx.cfg, operation: "doctor" });
      const { assertNoPendingLegacyExecApprovals } =
        await import("../infra/exec-approvals-migration-gate.js");
      assertNoPendingLegacyExecApprovals({ operation: "doctor" });
      const { repairGatewayMaintenanceStartupFailures } =
        await import("../infra/gateway-boot-lifecycle.js");
      repairGatewayMaintenanceStartupFailures();
    }
    await maintenance?.finish(ctx.cfg);
    doctorResult = ctx.postInstallDoctorResult ?? { status: "ok" };
    if (updateResult && doctorResult.status === "advisory") {
      exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
      return;
    }
  } catch (error) {
    if (maintenance) {
      const { DoctorStateMigrationRefusalError } =
        await import("../infra/state-migrations.messages.js");
      if (!(error instanceof DoctorStateMigrationRefusalError)) {
        effectiveRuntime.error(
          "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
        );
      }
    }
    throw error;
  } finally {
    try {
      await maintenance?.release();
    } finally {
      if (updateResult) {
        await writeUpdatePostInstallDoctorResult({
          resultPath: updateResult.resultPath,
          result: {
            ...doctorResult,
            configHash: updateResult.capture.hash,
            ...(updateResult.capture.inputHash === undefined
              ? {}
              : { configInputHash: updateResult.capture.inputHash }),
          },
        });
      }
    }
    // The default runtime exits synchronously; finish native recovery and release
    // maintenance leases before handing it an exit code.
    if (exitCode !== undefined) {
      effectiveRuntime.exit(exitCode);
    }
  }

  outro("Doctor complete.");
}
