// Doctor health flow renders interactive health check output.
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function doctorCommand(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  if (options.repair === true || options.yes === true || options.generateGatewayToken === true) {
    const { assertConfigWriteAllowedInCurrentMode } = await loadConfigModule();
    assertConfigWriteAllowedInCurrentMode();
  }

  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
  intro("OpenClaw doctor");

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

  outro("Doctor complete.");
}
