// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveStateDir } from "../config/paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

async function assertDoctorDatabaseSchemasCompatible(): Promise<void> {
  const [databasePreflight, agentDatabase, stateDatabase] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("../state/openclaw-agent-db-contract.js"),
    import("../state/openclaw-state-db-contract.js"),
  ]);
  const databaseSchemas = databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
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
      `Doctor cannot continue because the shared state database is unreadable: ${unreadableStateDatabase.path}: ${unreadableStateDatabase.reason}. The database was left unchanged; doctor will not recreate it because that could discard persistent operator data. Stop the Gateway and other OpenClaw processes, then restore this file from a verified backup or repair it manually. After recovery, run ${formatCliCommand("openclaw doctor --fix")} again. See ${stateDatabase.OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
    );
  }
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
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  // Config loading can initialize SQLite-backed state before integrity runs.
  // Preserve the entry fact so doctor can report that automatic initialization.
  const stateDirExistedAtStart = stateDirectoryExistsAtDoctorStart();
  intro("OpenClaw doctor");

  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });

  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime: effectiveRuntime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) {
    return;
  }

  // A stale source checkout may update itself, but no diagnostic or repair may
  // touch state until the surviving build proves it understands every database.
  await assertDoctorDatabaseSchemasCompatible();
  if (options.repair === true || options.yes === true || options.generateGatewayToken === true) {
    const { assertConfigWriteAllowedInCurrentMode } = await loadConfigModule();
    assertConfigWriteAllowedInCurrentMode();
  }

  const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
  const maintenance = await beginDoctorMaintenance({ options, root, runtime: effectiveRuntime });
  let exitCode: number | undefined;
  try {
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
      // complete while startup would still reject a legacy session store.
      const { assertSessionStoreMigrationComplete } =
        await import("../config/sessions/startup-migration.js");
      assertSessionStoreMigrationComplete({ cfg: ctx.cfg, env: process.env });
      const { assertOpenClawDatabasesReady } =
        await import("../state/openclaw-database-preflight.js");
      const { resolveConfiguredAgentDatabaseTargets } =
        await import("../config/sessions/targets.js");
      assertOpenClawDatabasesReady({
        env: process.env,
        operation: "doctor",
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(ctx.cfg, {
          env: process.env,
        }),
      });
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      assertConfiguredWorkspaceStateReady({ cfg: ctx.cfg });
    }
    await maintenance?.finish(ctx.cfg);
    if (ctx.postInstallDoctorResult) {
      const {
        UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
        writeUpdatePostInstallDoctorResult,
      } = await import("../infra/update-doctor-result.js");
      const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
      if (resultPath) {
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: ctx.postInstallDoctorResult,
        });
        exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
        return;
      }
    }
  } catch (error) {
    if (maintenance) {
      effectiveRuntime.error(
        "Doctor could not complete maintenance. Check the reported service state, resolve the failure, and rerun doctor --fix.",
      );
    }
    throw error;
  } finally {
    await maintenance?.release();
    // The default runtime exits synchronously; finish native recovery and release
    // maintenance leases before handing it an exit code.
    if (exitCode !== undefined) {
      effectiveRuntime.exit(exitCode);
    }
  }

  outro("Doctor complete.");
}
