import process from "node:process";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import type { CaptureProtocol } from "./types.js";

export type DebugProxyCoverageStatus = "captured" | "proxy-only" | "uncovered";

export type DebugProxyCoverageEntry = {
  id: string;
  label: string;
  modulePath: string;
  protocols: CaptureProtocol[];
  status: DebugProxyCoverageStatus;
  notes: string;
};

export type DebugProxyCoverageSummary = {
  total: number;
  captured: number;
  proxyOnly: number;
  uncovered: number;
};

const DEBUG_PROXY_COVERAGE_ENTRIES: readonly DebugProxyCoverageEntry[] = [
  {
    id: "provider-transport-fetch",
    label: "Provider HTTP transport",
    modulePath: "src/agents/provider-transport-fetch.ts",
    protocols: ["http", "https", "sse"],
    status: "captured",
    notes:
      "Central provider fetch seam routes through explicit proxy overrides and records request/response payloads.",
  },
  {
    id: "discord-rest",
    label: "Discord REST monitor fetch",
    modulePath: "extensions/discord/monitor/rest-fetch.ts",
    protocols: ["http", "https"],
    status: "captured",
    notes: "Discord monitor REST calls inherit the debug proxy and record HTTP exchanges.",
  },
  {
    id: "discord-gateway",
    label: "Discord gateway monitor",
    modulePath: "extensions/discord/monitor/gateway-plugin.ts",
    protocols: ["https", "wss"],
    status: "captured",
    notes:
      "Gateway metadata fetches and websocket lifecycle events are captured for monitor traffic.",
  },
  {
    id: "telegram-fetch",
    label: "Telegram fetch resolver",
    modulePath: "extensions/telegram/fetch.ts",
    protocols: ["http", "https"],
    status: "captured",
    notes:
      "Telegram API fetch fallback picks up debug proxy env and records outbound/inbound exchanges.",
  },
  {
    id: "mattermost-ws",
    label: "Mattermost monitor websocket",
    modulePath: "extensions/mattermost/mattermost/monitor-websocket.ts",
    protocols: ["ws", "wss"],
    status: "captured",
    notes: "Mattermost websocket monitor uses the debug proxy agent and records frame activity.",
  },
  {
    id: "openai-realtime-voice",
    label: "OpenAI realtime voice bridge",
    modulePath: "extensions/openai/realtime-voice-provider.ts",
    protocols: ["wss"],
    status: "captured",
    notes:
      "Realtime voice bridge now routes through the debug proxy agent and records websocket frames.",
  },
  {
    id: "openai-realtime-transcription",
    label: "OpenAI realtime transcription",
    modulePath: "extensions/openai/realtime-transcription-provider.ts",
    protocols: ["wss"],
    status: "captured",
    notes:
      "Realtime transcription sessions now route through the debug proxy agent and record websocket frames.",
  },
  {
    id: "openai-tts",
    label: "OpenAI text-to-speech",
    modulePath: "extensions/openai/tts.ts",
    protocols: ["https"],
    status: "captured",
    notes:
      "Direct OpenAI TTS fetches record request/response payloads while inheriting proxy env routing.",
  },
  {
    id: "microsoft-voices",
    label: "Microsoft voice discovery",
    modulePath: "extensions/microsoft/speech-provider.ts",
    protocols: ["https"],
    status: "captured",
    notes:
      "Microsoft voice listing fetches record HTTP exchanges and follow process-wide proxy routing.",
  },
  {
    id: "feishu-client-http",
    label: "Feishu SDK HTTP client",
    modulePath: "extensions/feishu/client.ts",
    protocols: ["https"],
    status: "proxy-only",
    notes:
      "Feishu SDK traffic can inherit ambient proxying, but decrypted request/response capture is not yet wired at the SDK seam.",
  },
  {
    id: "feishu-client-ws",
    label: "Feishu SDK websocket client",
    modulePath: "extensions/feishu/client.ts",
    protocols: ["wss"],
    status: "proxy-only",
    notes:
      "Feishu websocket creation can inherit ambient proxying, but websocket frame capture is not yet wired.",
  },
];

let warnedCoverageSessionKey: string | null = null;

export function listDebugProxyCoverageEntries(): DebugProxyCoverageEntry[] {
  return DEBUG_PROXY_COVERAGE_ENTRIES.map((entry) => ({
    ...entry,
    protocols: [...entry.protocols],
  }));
}

export function summarizeDebugProxyCoverage(
  entries: readonly DebugProxyCoverageEntry[] = DEBUG_PROXY_COVERAGE_ENTRIES,
): DebugProxyCoverageSummary {
  let captured = 0;
  let proxyOnly = 0;
  let uncovered = 0;
  for (const entry of entries) {
    if (entry.status === "captured") {
      captured += 1;
      continue;
    }
    if (entry.status === "proxy-only") {
      proxyOnly += 1;
      continue;
    }
    uncovered += 1;
  }
  return {
    total: entries.length,
    captured,
    proxyOnly,
    uncovered,
  };
}

export function buildDebugProxyCoverageReport() {
  const entries = listDebugProxyCoverageEntries();
  return {
    summary: summarizeDebugProxyCoverage(entries),
    entries,
  };
}

export function maybeWarnAboutDebugProxyCoverage(
  settings: DebugProxySettings = resolveDebugProxySettings(),
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): void {
  if (!settings.enabled || !settings.required) {
    return;
  }
  const sessionKey = `${settings.sessionId}:${settings.proxyUrl ?? ""}`;
  if (warnedCoverageSessionKey === sessionKey) {
    return;
  }
  warnedCoverageSessionKey = sessionKey;

  const report = buildDebugProxyCoverageReport();
  const { summary } = report;
  const partial = report.entries.filter((entry) => entry.status !== "captured");
  if (partial.length === 0) {
    return;
  }
  warn(
    `[openclaw proxy] debug proxy coverage: ${summary.captured}/${summary.total} captured, ${summary.proxyOnly} proxy-only, ${summary.uncovered} uncovered.`,
  );
  warn(
    `[openclaw proxy] remaining gaps: ${partial.map((entry) => entry.id).join(", ")}. Run \`openclaw proxy coverage\` for details.`,
  );
}
