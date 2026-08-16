// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
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
    import("../state/openclaw-agent-db.js"),
    import("../state/openclaw-state-db.js"),
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
    runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
    invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
  };
  const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
  await runDoctorHealthContributions(ctx);
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
      effectiveRuntime.exit(UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE);
      return;
    }
  }

  if (ctx.configWriteBlockedByValidation) {
    // Config fixes were computed but refused by write validation; the warning
    // above already lists the manual work. When an earlier pass committed, only
    // the later fixes are missing. Exit non-zero so --fix callers see that the
    // run did not converge.
    outro(
      ctx.configResultWriteCommitted === true
        ? "Doctor finished, but some config fixes were not applied."
        : "Doctor finished, but config fixes were not applied.",
    );
    effectiveRuntime.exit(1);
    return;
  }
  outro("Doctor complete.");
}
