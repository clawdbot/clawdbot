import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
/**
 * Interactive remote gateway onboarding.
 *
 * It can discover gateways, validate remote WebSocket security, and store
 * a remote Gateway secret as plaintext or a secret reference.
 */
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

export function validateGatewayWebSocketUrl(value: string): string | undefined {
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

/** Prompts for remote gateway connection and auth settings. */
export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { secretInputMode?: SecretInputMode; remoteOriginUrl?: string },
): Promise<OpenClawConfig> {
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;
  let discoveryRemote:
    | { url: string; transport: "direct" | "ssh"; tlsFingerprint?: string }
    | undefined;

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
    // Wide-area discovery is bounded and optional; manual URL entry remains the
    // fallback so setup is usable without Bonjour or DNS-SD results.
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
        const idx = parseStrictNonNegativeInteger(selection);
        selectedBeacon = idx === undefined ? null : (beacons[idx] ?? null);
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
          discoveryRemote = {
            url: suggestedUrl,
            transport: "direct",
            ...(fingerprint ? { tlsFingerprint: fingerprint } : {}),
          };
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
        discoveryRemote = { url: suggestedUrl, transport: "ssh" };
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
  // Discovery choices belong only to the accepted URL, never a subsequent manual edit.
  const selectedDiscovery = discoveryRemote?.url === url ? discoveryRemote : undefined;

  // A saved secret belongs to the selected endpoint, not a newly entered URL or tunnel.
  const existingSecret =
    (!cfg.gateway?.remote?.url || url === cfg.gateway.remote.url.trim()) &&
    selectedDiscovery?.transport !== "ssh"
      ? (cfg.gateway?.remote?.token ?? cfg.gateway?.remote?.password)
      : undefined;
  let token: SecretInput | undefined;
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
    const noSecret = await prompter.confirm({
      message: t("wizard.remote.noSecretConfirm"),
      initialValue: false,
    });
    if (!noSecret) {
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
    }
  } else {
    while (true) {
      const input = (
        await prompter.text({
          message: t("wizard.remote.tokenPrompt"),
          placeholder: t("wizard.remote.secretPlaceholder"),
          sensitive: true,
        })
      ).trim();
      if (input) {
        token = input;
        break;
      }
      if (
        existingSecret &&
        (await prompter.confirm({
          message: t("wizard.remote.keepSecretConfirm"),
          initialValue: true,
        }))
      ) {
        token = existingSecret;
        break;
      }
      if (
        await prompter.confirm({
          message: t("wizard.remote.noSecretConfirm"),
          initialValue: false,
        })
      ) {
        break;
      }
    }
  }
  // An explicitly absent origin means onboarding had no saved endpoint before URL seeding.
  const remoteOriginUrl =
    options && "remoteOriginUrl" in options ? options.remoteOriginUrl : cfg.gateway?.remote?.url;
  const edgeAuth =
    remoteOriginUrl && gatewayOriginScope(url) === gatewayOriginScope(remoteOriginUrl)
      ? cfg.gateway?.remote?.edgeAuth
      : undefined;

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        // A newly suggested manual tunnel can reach another host behind the same loopback URL.
        ...(url === remoteOriginUrl?.trim() && selectedDiscovery?.transport !== "ssh"
          ? cfg.gateway?.remote
          : {}),
        url,
        edgeAuth,
        token,
        password: undefined,
        ...(selectedDiscovery?.transport === "direct" ? selectedDiscovery : {}),
      },
    },
  };
}
