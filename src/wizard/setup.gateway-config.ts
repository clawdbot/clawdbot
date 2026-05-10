import { formatPortRangeHint } from "../cli/error-format.js";
import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "../commands/onboard-helpers.js";
import type { GatewayAuthChoice, SecretInputMode } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, OpenClawConfig } from "../config/config.js";
import { ensureControlUiAllowedOriginsForNonLoopbackBind } from "../config/gateway-control-ui-origins.js";
import {
  normalizeSecretInputString,
  resolveSecretInputRef,
  type SecretInput,
} from "../config/types.secrets.js";
import {
  maybeAddTailnetOriginToControlUiAllowedOrigins,
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
} from "../gateway/gateway-config-prompts.shared.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import { resolveSecretInputModeForEnvSelection } from "../plugins/provider-auth-mode.js";
import { promptSecretRefForSetup } from "../plugins/provider-auth-ref.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import { maskApiKey } from "../utils/mask-api-key.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type {
  GatewayWizardSettings,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./setup.types.js";

type ConfigureGatewayOptions = {
  flow: WizardFlow;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  secretInputMode?: SecretInputMode;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

type ConfigureGatewayResult = {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
};

function normalizeWizardTextInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateGatewayPortInput(value: unknown): string | undefined {
  const port = Number(normalizeWizardTextInput(value));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return formatPortRangeHint();
  }
  return undefined;
}

export async function configureGatewayForSetup(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { flow, localPort, quickstartGateway, prompter } = opts;
  let { nextConfig } = opts;

  const port =
    flow === "quickstart"
      ? quickstartGateway.port
      : Number.parseInt(
          normalizeWizardTextInput(
            await prompter.text({
              message: "Gateway port",
              initialValue: String(localPort),
              validate: validateGatewayPortInput,
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"] =
    flow === "quickstart"
      ? quickstartGateway.bind
      : await prompter.select<GatewayWizardSettings["bind"]>({
          message: "Gateway bind address",
          options: [
            { value: "loopback", label: "Loopback (127.0.0.1)", hint: "This machine only" },
            { value: "lan", label: "LAN (0.0.0.0)", hint: "Reachable on your local network" },
            { value: "tailnet", label: "Tailnet (Tailscale IP)", hint: "Reachable over Tailscale" },
            { value: "auto", label: "Auto (Loopback -> LAN)", hint: "Try loopback first" },
            { value: "custom", label: "Custom IP", hint: "Bind to one local address" },
          ],
        });

  let customBindHost = quickstartGateway.customBindHost;
  if (bind === "custom") {
    const needsPrompt = flow !== "quickstart" || !customBindHost;
    if (needsPrompt) {
      const input = await prompter.text({
        message: "Custom IP address",
        placeholder: "192.168.1.100",
        initialValue: customBindHost ?? "",
        validate: validateIPv4AddressInput,
      });
      customBindHost = typeof input === "string" ? input.trim() : undefined;
    }
  }

  let authMode =
    flow === "quickstart"
      ? quickstartGateway.authMode
      : ((await prompter.select({
          message: "Gateway access protection",
          options: [
            {
              value: "token",
              label: "Token (recommended)",
              hint: "Recommended default (local + remote)",
            },
            { value: "password", label: "Password" },
          ],
          initialValue: "token",
        })) as GatewayAuthChoice);

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] =
    flow === "quickstart"
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: "Tailscale exposure",
          options: [...TAILSCALE_EXPOSURE_OPTIONS],
        });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  // Persist the path so getTailnetHostname can reuse it for origin injection.
  let tailscaleBin: string | null = null;
  if (tailscaleMode !== "off") {
    tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      await prompter.note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
    }
  }

  let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
    tailscaleResetOnExit = await prompter.confirm({
      message: "Reset Tailscale serve/funnel on exit?",
      initialValue: false,
    });
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note(
      "Tailscale exposure requires bind=loopback. I will switch the bind address to loopback.",
      "Gateway bind",
    );
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note(
      "Tailscale Funnel requires password auth. I will switch Gateway auth to password.",
      "Gateway auth",
    );
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayTokenInput: SecretInput | undefined;
  if (authMode === "token") {
    const quickstartTokenString = normalizeSecretInputString(quickstartGateway.token);
    const quickstartTokenRef = resolveSecretInputRef({
      value: quickstartGateway.token,
      defaults: nextConfig.secrets?.defaults,
    }).ref;
    const tokenMode =
      flow === "quickstart" && opts.secretInputMode !== "ref" // pragma: allowlist secret
        ? quickstartTokenRef
          ? "ref"
          : "plaintext"
        : await resolveSecretInputModeForEnvSelection({
            prompter,
            explicitMode: opts.secretInputMode,
            copy: {
              modeMessage: "How do you want to provide the gateway token?",
              plaintextLabel: "Generate/store plaintext token",
              plaintextHint: "Default",
              refLabel: "Use SecretRef",
              refHint: "Store a reference instead of plaintext",
            },
          });
    if (tokenMode === "ref") {
      if (flow === "quickstart" && quickstartTokenRef) {
        gatewayTokenInput = quickstartTokenRef;
        gatewayToken = await resolveSetupSecretInputString({
          config: nextConfig,
          value: quickstartTokenRef,
          path: "gateway.auth.token",
          env: process.env,
        });
      } else {
        const resolved = await promptSecretRefForSetup({
          provider: "gateway-auth-token",
          config: nextConfig,
          prompter,
          preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
          copy: {
            sourceMessage: "Where is this gateway token stored?",
            envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
          },
        });
        gatewayTokenInput = resolved.ref;
        gatewayToken = resolved.resolvedValue;
      }
    } else if (flow === "quickstart") {
      gatewayToken =
        (quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN)) ||
        randomToken();
      gatewayTokenInput = gatewayToken;
    } else {
      const existingToken =
        quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
      let tokenInput: string | undefined;
      if (existingToken) {
        const keep = await prompter.confirm({
          message: `Use existing gateway token (${maskApiKey(existingToken)})?`,
          initialValue: true,
        });
        tokenInput = keep
          ? existingToken
          : await prompter.text({
              message: "Gateway token (blank to generate)",
              placeholder: "Needed for multi-machine or non-loopback access",
              sensitive: true,
            });
      } else {
        tokenInput = await prompter.text({
          message: "Gateway token (blank to generate)",
          placeholder: "Needed for multi-machine or non-loopback access",
          sensitive: true,
        });
      }
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
      gatewayTokenInput = gatewayToken;
    }
  }

  if (authMode === "password") {
    let password: SecretInput | undefined =
      flow === "quickstart" && quickstartGateway.password ? quickstartGateway.password : undefined;
    if (!password) {
      const selectedMode = await resolveSecretInputModeForEnvSelection({
        prompter,
        explicitMode: opts.secretInputMode,
        copy: {
          modeMessage: "How do you want to provide the gateway password?",
          plaintextLabel: "Enter password now",
          plaintextHint: "Stores the password directly in OpenClaw config",
        },
      });
      if (selectedMode === "ref") {
        const resolved = await promptSecretRefForSetup({
          provider: "gateway-auth-password",
          config: nextConfig,
          prompter,
          preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
          copy: {
            sourceMessage: "Where is this gateway password stored?",
            envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
          },
        });
        password = resolved.ref;
      } else {
        password = normalizeWizardTextInput(
          await prompter.text({
            message: "Gateway password",
            validate: validateGatewayPasswordInput,
            sensitive: true,
          }),
        );
      }
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayTokenInput,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind: bind as GatewayBindMode,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  if (
    flow === "quickstart" &&
    bind === "loopback" &&
    nextConfig.gateway?.controlUi?.allowInsecureAuth === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        controlUi: {
          ...nextConfig.gateway?.controlUi,
          allowInsecureAuth: true,
        },
      },
    };
  }

  nextConfig = ensureControlUiAllowedOriginsForNonLoopbackBind(nextConfig, {
    requireControlUiEnabled: true,
  }).config;
  nextConfig = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: nextConfig,
    tailscaleMode,
    tailscaleBin,
  });

  // If this is a new gateway setup (no existing gateway settings), start with a
  // denylist for high-risk node commands. Users can arm these temporarily via
  // /phone arm ... (phone-control plugin).
  if (
    !quickstartGateway.hasExisting &&
    nextConfig.gateway?.nodes?.denyCommands === undefined &&
    nextConfig.gateway?.nodes?.allowCommands === undefined &&
    nextConfig.gateway?.nodes?.browser === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        nodes: {
          ...nextConfig.gateway?.nodes,
          denyCommands: [...DEFAULT_DANGEROUS_NODE_COMMANDS],
        },
      },
    };
  }

  return {
    nextConfig,
    settings: {
      port,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      authMode,
      gatewayToken,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
