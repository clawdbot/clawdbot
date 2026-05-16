import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import { isSecureWebSocketUrl } from "../gateway/net.js";
import { discoverGatewayBeacons, type GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import {
  buildGatewayDiscoveryLabel,
  buildGatewayDiscoveryTarget,
} from "../infra/gateway-discovery-targets.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import { resolveSecretInputModeForEnvSelection } from "../plugins/provider-auth-mode.js";
import { promptSecretRefForSetup } from "../plugins/provider-auth-ref.js";
import { maskApiKey } from "../utils/mask-api-key.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

function buildLabel(beacon: GatewayBonjourBeacon): string {
  return buildGatewayDiscoveryLabel(beacon);
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

function validateGatewayWebSocketUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return t("wizard.remote.validWebSocketUrl");
  }
  if (
    !isSecureWebSocketUrl(trimmed, {
      allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1",
    })
  ) {
    return t("wizard.remote.insecureRemoteUrl");
  }
  return undefined;
}

export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { secretInputMode?: SecretInputMode },
): Promise<OpenClawConfig> {
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;
  let discoveryTlsFingerprint: string | undefined;
  let trustedDiscoveryUrl: string | undefined;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        message: t("wizard.remote.bonjour"),
        initialValue: true,
      })
    : false;

  if (!hasBonjourTool) {
    await prompter.note(
      [
        "Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).",
        "Docs: https://docs.openclaw.ai/gateway/discovery",
      ].join("\n"),
      "Discovery",
    );
  }

  if (wantsDiscover) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: cfg.discovery?.wideArea?.domain,
    });
    const spin = prompter.progress(t("wizard.remote.searchProgress"));
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000, wideAreaDomain });
    spin.stop(
      beacons.length > 0
        ? t("wizard.remote.foundGateways", { count: beacons.length })
        : t("wizard.remote.noGatewaysFound"),
    );

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: t("wizard.remote.selectGateway"),
        options: [
          ...beacons.map((beacon, index) => ({
            value: String(index),
            label: buildLabel(beacon),
          })),
          { value: "manual", label: t("wizard.remote.enterUrlManually") },
        ],
      });
      if (selection !== "manual") {
        const idx = Number.parseInt(selection, 10);
        selectedBeacon = Number.isFinite(idx) ? (beacons[idx] ?? null) : null;
      }
    }
  }

  if (selectedBeacon) {
    const target = buildGatewayDiscoveryTarget(selectedBeacon);
    if (target.endpoint) {
      const { host, port } = target.endpoint;
      const mode = await prompter.select({
        message: t("wizard.remote.connectionMethod"),
        options: [
          {
            value: "direct",
            label: `Direct gateway WS (${host}:${port})`,
          },
          { value: "ssh", label: t("wizard.remote.sshTunnel") },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `wss://${host}:${port}`;
        const fingerprint = target.endpoint.gatewayTlsFingerprintSha256;
        const trusted = await prompter.confirm({
          message: t("wizard.remote.trustGateway", {
            host: `${host}:${port}`,
            fingerprint: fingerprint ?? t("wizard.remote.fingerprintMissing"),
          }),
          initialValue: false,
        });
        if (trusted) {
          discoveryTlsFingerprint = fingerprint;
          trustedDiscoveryUrl = suggestedUrl;
          await prompter.note(
            [
              t("wizard.remote.directDefaultsTls"),
              `Using: ${suggestedUrl}`,
              ...(fingerprint ? [`TLS pin: ${fingerprint}`] : []),
              t("wizard.remote.loopbackSshHint"),
            ].join("\n"),
            t("wizard.remote.directAccessTitle"),
          );
        } else {
          // Clear the discovered endpoint so the manual prompt falls back to a safe default.
          suggestedUrl = DEFAULT_GATEWAY_URL;
        }
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        await prompter.note(
          [
            "Start a tunnel before using the CLI:",
            `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${target.sshPort ? ` -p ${target.sshPort}` : ""}`,
            "Docs: https://docs.openclaw.ai/gateway/remote",
          ].join("\n"),
          t("wizard.remote.sshTunnelTitle"),
        );
      }
    }
  }

  const urlInput = await prompter.text({
    message: t("wizard.remote.websocketUrl"),
    initialValue: suggestedUrl,
    validate: (value) => validateGatewayWebSocketUrl(value),
  });
  const url = ensureWsUrl(urlInput);
  const pinnedDiscoveryFingerprint =
    discoveryTlsFingerprint && url === trustedDiscoveryUrl ? discoveryTlsFingerprint : undefined;

  const authChoice = await prompter.select({
    message: t("wizard.remote.auth"),
    options: [
      { value: "token", label: t("common.tokenRecommended") },
      { value: "password", label: t("common.password") },
      { value: "off", label: t("common.noAuth") },
    ],
  });

  let token: SecretInput | undefined = cfg.gateway?.remote?.token;
  let password: SecretInput | undefined = cfg.gateway?.remote?.password;
  if (authChoice === "token") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: t("wizard.gateway.remoteTokenMode"),
        plaintextLabel: t("wizard.remote.plaintextTokenLabel"),
        plaintextHint: t("wizard.remote.plaintextTokenHint"),
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForSetup({
        provider: "gateway-remote-token",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
        copy: {
          sourceMessage: t("wizard.remote.gatewayTokenStoredMessage"),
          envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
        },
      });
      token = resolved.ref;
    } else {
      const existingToken = typeof token === "string" ? token : undefined;
      if (
        existingToken &&
        (await prompter.confirm({
          message: t("wizard.gateway.existingTokenConfirm", { token: maskApiKey(existingToken) }),
          initialValue: true,
        }))
      ) {
        token = existingToken;
      } else {
        token = (
          await prompter.text({
            message: t("wizard.remote.tokenPrompt"),
            validate: (value) => (value?.trim() ? undefined : t("common.required")),
            sensitive: true,
          })
        ).trim();
      }
    }
    password = undefined;
  } else if (authChoice === "password") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: t("wizard.gateway.remotePasswordMode"),
        plaintextLabel: t("wizard.remote.plaintextPasswordLabel"),
        plaintextHint: t("wizard.remote.plaintextPasswordHint"),
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForSetup({
        provider: "gateway-remote-password",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
        copy: {
          sourceMessage: t("wizard.remote.gatewayPasswordStoredMessage"),
          envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
        },
      });
      password = resolved.ref;
    } else {
      const existingPassword = typeof password === "string" ? password : undefined;
      if (
        existingPassword &&
        (await prompter.confirm({
          message: t("wizard.gateway.existingPasswordConfirm", {
            password: maskApiKey(existingPassword),
          }),
          initialValue: true,
        }))
      ) {
        password = existingPassword;
      } else {
        password = (
          await prompter.text({
            message: t("wizard.remote.passwordPrompt"),
            validate: (value) => (value?.trim() ? undefined : t("common.required")),
            sensitive: true,
          })
        ).trim();
      }
    }
    token = undefined;
  } else {
    token = undefined;
    password = undefined;
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        ...(token !== undefined ? { token } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(pinnedDiscoveryFingerprint ? { tlsFingerprint: pinnedDiscoveryFingerprint } : {}),
      },
    },
  };
}
