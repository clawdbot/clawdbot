import { t } from "../../i18n/index.ts";
import { formatDurationCompact, formatRelativeTimestamp } from "../../lib/format.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import type { DraftEnvironment } from "./discovery.ts";

const MAX_PLACE_MENU_FACTS = 4;
const CAPABILITY_FACT_KEYS = {
  camera: "newSession.capabilityCamera",
  location: "newSession.capabilityLocation",
  talk: "newSession.capabilityTalk",
  screen: "newSession.capabilityScreenCapture",
  canvas: "newSession.capabilityCanvas",
  microphone: "newSession.capabilityVoice",
  voice: "newSession.capabilityVoice",
} as const;

function environmentLifecycleFact(params: {
  environment: DraftEnvironment | undefined;
  connected: boolean;
  nowMs: number;
}): string | undefined {
  if (params.connected) {
    return undefined;
  }
  const environment = params.environment;
  if (environment?.lastConnectedAtMs === undefined) {
    return t("newSession.neverConnected");
  }
  if (environment.lastDisconnectedAtMs !== undefined) {
    const duration =
      formatDurationCompact(Math.max(0, params.nowMs - environment.lastDisconnectedAtMs)) ??
      t("common.justNow");
    return t("newSession.offlineFor", { duration });
  }
  const lastSeenAtMs = environment.lastSeenAtMs ?? environment.lastConnectedAtMs;
  return t("newSession.lastSeen", {
    time: formatRelativeTimestamp(lastSeenAtMs),
  });
}

export function environmentMenuFacts(
  environment: DraftEnvironment | undefined,
  options: { connected?: boolean; nowMs?: number } = {},
): string[] {
  const updateIssue = environment?.issues?.find((issue) => issue.code === "update-required");
  const lifecycle = environmentLifecycleFact({
    environment,
    connected: options.connected ?? true,
    nowMs: options.nowMs ?? Date.now(),
  });
  const priorityFact = updateIssue
    ? t("newSession.nodeUpdateRequired", {
        updateCommand: updateIssue.updateCommand,
        restartCommand: updateIssue.headlessReconnectCommand,
      })
    : lifecycle;
  const facts = priorityFact ? [priorityFact] : [];
  if (environment?.workerSlots) {
    facts.push(
      t("newSession.workerSlots", {
        available: String(environment.workerSlots.available),
        total: String(environment.workerSlots.total),
      }),
    );
  }
  if (environment?.platform) {
    facts.push(prettifyPlatform(environment.platform));
  }
  for (const capability of environment?.capabilities ?? []) {
    const family = capability.split(".", 1)[0]?.toLowerCase();
    const key = family
      ? CAPABILITY_FACT_KEYS[family as keyof typeof CAPABILITY_FACT_KEYS]
      : undefined;
    const fact = key ? t(key) : undefined;
    if (fact && !facts.includes(fact)) {
      facts.push(fact);
    }
    if (facts.length >= MAX_PLACE_MENU_FACTS) {
      break;
    }
  }
  return facts;
}
