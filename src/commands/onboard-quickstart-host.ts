import { resolveGatewayRunOptions } from "../cli/gateway-cli/run-options.js";
import type { runGatewayCommand } from "../cli/gateway-cli/run.js";
import { getGatewayRunRuntimeHooks } from "../cli/gateway-cli/runtime-hooks.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import type { RuntimeEnv } from "../runtime.js";
import { createQuickstartNotePrompter } from "../system-agent/setup-apply.js";
import { t } from "../wizard/i18n/index.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";
import { runBrowserHatchHandoff } from "./onboard-browser-handoff.js";
import { resolveLocalControlUiProbeLinks, waitForGatewayReachable } from "./onboard-helpers.js";

type QuickstartForegroundGatewayDeps = {
  readConfigSnapshot?: () => Promise<Pick<ConfigFileSnapshot, "config">>;
  runGateway?: typeof runGatewayCommand;
  waitForGateway?: typeof waitForGatewayReachable;
  runBrowserHandoff?: typeof runBrowserHatchHandoff;
};

/** Own the foreground Gateway after the wizard has restored terminal input. */
export async function runQuickstartForegroundGateway(
  params: { runtime: RuntimeEnv; suppressTokenOutput?: boolean },
  deps: QuickstartForegroundGatewayDeps = {},
): Promise<void> {
  const { runtime } = params;
  const { config } = await (deps.readConfigSnapshot ?? readConfigFileSnapshot)();
  const links = resolveLocalControlUiProbeLinks({
    bind: config.gateway?.bind,
    port: resolveGatewayPort(config),
    customBindHost: config.gateway?.customBindHost,
    basePath: config.gateway?.controlUi?.basePath,
    tlsEnabled: config.gateway?.tls?.enabled === true,
  });
  const credentials = await resolveGatewayCredentialsWithSecretInputs({
    config,
    modeOverride: "local",
  });
  const authMode = config.gateway?.auth?.mode ?? (credentials.password ? "password" : "token");
  const runGateway =
    deps.runGateway ?? (await import("../cli/gateway-cli/run.js")).runGatewayCommand;
  const gateway = runGateway(resolveGatewayRunOptions({}), getGatewayRunRuntimeHooks());
  const stopped = gateway.then(() => null);
  const reachable = await Promise.race([
    stopped,
    (deps.waitForGateway ?? waitForGatewayReachable)({
      url: links.wsUrl,
      token: authMode === "token" ? credentials.token : undefined,
      password: authMode === "password" ? credentials.password : undefined,
      ...resolveGatewayStartupTiming(),
    }),
  ]);
  if (!reachable) {
    return;
  }
  if (reachable.ok) {
    // Browser failure must not end the process that now owns the Gateway.
    const handoff = await Promise.race([
      stopped,
      (deps.runBrowserHandoff ?? runBrowserHatchHandoff)({
        config,
        prompter: createQuickstartNotePrompter(runtime),
        suppressTokenOutput: params.suppressTokenOutput,
      }).catch(() => ({ handedOff: false })),
    ]);
    if (!handoff) {
      return;
    }
    if (!handoff.handedOff) {
      runtime.log(t("wizard.guided.quickstartBrowserUnavailable"));
    }
  } else {
    runtime.log(t("wizard.guided.quickstartGatewayPending"));
  }
  runtime.log(t("wizard.guided.quickstartDashboard", { url: links.httpUrl }));
  runtime.log(t("wizard.guided.quickstartForeground"));
  runtime.log(t("wizard.guided.quickstartBackground"));
  runtime.log(t("wizard.guided.quickstartReopen"));
  await gateway;
}
