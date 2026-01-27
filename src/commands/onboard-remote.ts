import type { MoltbotConfig } from "../config/config.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

function pickHost(beacon: GatewayBonjourBeacon): string | undefined {
  return beacon.tailnetDns || beacon.lanHost || beacon.host;
}

function buildLabel(beacon: GatewayBonjourBeacon): string {
  const host = pickHost(beacon);
  const port = beacon.gatewayPort ?? beacon.port ?? 18789;
  const title = beacon.displayName ?? beacon.instanceName;
  const hint = host ? `${host}:${port}` : "host unknown";
  return `${title} (${hint})`;
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_GATEWAY_URL;
  return trimmed;
}

export async function promptRemoteGatewayConfig(
  cfg: MoltbotConfig,
  prompter: WizardPrompter,
): Promise<MoltbotConfig> {
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        message: "Discover gateway on LAN (Bonjour)?",
        initialValue: true,
      })
    : false;

  if (!hasBonjourTool) {
    await prompter.note(
      [
        "Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).",
        "Docs: https://docs.molt.bot/gateway/discovery",
      ].join("\n"),
      "Discovery",
    );
  }

  if (wantsDiscover) {
    const spin = prompter.progress("Searching for gateways…");
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000 });
    spin.stop(beacons.length > 0 ? `Found ${beacons.length} gateway(s)` : "No gateways found");

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: "Select gateway",
        options: [
          ...beacons.map((beacon, index) => ({
            value: String(index),
            label: buildLabel(beacon),
          })),
          { value: "manual", label: "Enter URL manually" },
        ],
      });
      if (selection !== "manual") {
        const idx = Number.parseInt(String(selection), 10);
        selectedBeacon = Number.isFinite(idx) ? (beacons[idx] ?? null) : null;
      }
    }
  }

  if (selectedBeacon) {
    const host = pickHost(selectedBeacon);
    const port = selectedBeacon.gatewayPort ?? 18789;
    if (host) {
      const mode = await prompter.select({
        message: "Connection method",
        options: [
          {
            value: "direct",
            label: `Direct gateway WS (${host}:${port})`,
          },
          { value: "ssh", label: "SSH tunnel (loopback)" },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `ws://${host}:${port}`;
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        await prompter.note(
          [
            "Start a tunnel before using the CLI:",
            `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${
              selectedBeacon.sshPort ? ` -p ${selectedBeacon.sshPort}` : ""
            }`,
            "Docs: https://docs.molt.bot/gateway/remote",
          ].join("\n"),
          "SSH tunnel",
        );
      }
    }
  }

  const urlInput = await prompter.text({
    message: "Gateway WebSocket URL",
    initialValue: suggestedUrl,
    validate: (value) =>
      String(value).trim().startsWith("ws://") || String(value).trim().startsWith("wss://")
        ? undefined
        : "URL must start with ws:// or wss://",
  });
  const url = ensureWsUrl(String(urlInput));

  const authChoice = (await prompter.select({
    message: "Gateway auth",
    options: [
      { value: "token", label: "Token (recommended)" },
      { value: "off", label: "No auth" },
    ],
  })) as "token" | "off";

  let token = cfg.gateway?.remote?.token ?? "";
  if (authChoice === "token") {
    token = String(
      await prompter.text({
        message: "Gateway token",
        initialValue: token,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
  } else {
    token = "";
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        token: token || undefined,
      },
    },
  };
}
