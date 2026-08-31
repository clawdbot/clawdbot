/** Builds non-sensitive, client-useful classification facts for Gateway session rows. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  SessionClassification,
  SessionPeerKind,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey, parseSessionDeliveryRoute } from "../routing/session-key.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";

const BACKGROUND_CLASSIFICATIONS = new Set<SessionClassification>([
  "acp",
  "cron",
  "dreaming",
  "harness",
  "heartbeat",
  "hook",
  "subagent",
  "system",
]);

type GatewaySessionClassification = {
  classification: SessionClassification;
  agentId?: string;
  accountId?: string;
  peerKind?: SessionPeerKind;
  isMain: boolean;
  // Classification only: this does not change session visibility, sharing,
  // retention, or authorization semantics.
  isBackground: boolean;
};

function classifyRest(rest: string): SessionClassification {
  const normalized = normalizeLowercaseStringOrEmpty(rest);
  if (normalized.startsWith("dashboard:")) {
    return "dashboard";
  }
  if (normalized.startsWith("tui-")) {
    return "tui";
  }
  if (normalized.startsWith("explicit:")) {
    return "explicit";
  }
  if (normalized.startsWith("hook:")) {
    return "hook";
  }
  if (normalized.startsWith("node-") || normalized.startsWith("node:")) {
    return "node";
  }
  if (normalized.startsWith("harness:")) {
    return "harness";
  }
  if (normalized.startsWith("voice:")) {
    return "voice";
  }
  if (normalized.startsWith("dreaming-narrative-")) {
    return "dreaming";
  }
  if (normalized === "boot" || normalized.startsWith("internal-session-effects:")) {
    return "system";
  }
  return "custom";
}

/**
 * Derive portable facts without exposing peer ids, transcript text, absolute
 * paths, or other data that is not already a session-list field.
 */
export function sessionClassificationForRow(
  cfg: OpenClawConfig,
  key: string,
  agentId: string,
  entry?: SessionEntry,
): GatewaySessionClassification {
  const canonicalKey = normalizeSessionKeyPreservingOpaquePeerIds(key);
  const isMain =
    canonicalKey === "global"
      ? cfg.session?.scope === "global"
      : canonicalKey === resolveAgentMainSessionKey({ cfg, agentId });
  const parsedAgent = parseAgentSessionKey(canonicalKey);
  const resolvedAgentId = parsedAgent?.agentId ?? normalizeOptionalString(agentId);
  const rest = parsedAgent?.rest ?? canonicalKey;
  const parsedThread = parseThreadSessionSuffix(canonicalKey);
  const route = parseSessionDeliveryRoute(canonicalKey);
  const hasLegacyDirectPeer = /^(?:direct|dm):.+$/i.test(
    parseAgentSessionKey(parsedThread.baseSessionKey)?.rest ?? "",
  );
  const hasDirectPeer =
    route?.peerKind === "direct" ||
    route?.peerKind === "dm" ||
    hasLegacyDirectPeer ||
    entry?.chatType === "direct";

  let classification: SessionClassification;
  if (canonicalKey === "global") {
    classification = "global";
  } else if (canonicalKey === "unknown") {
    classification = "unknown";
  } else if (entry?.heartbeatIsolatedBaseSessionKey) {
    classification = "heartbeat";
  } else if (isMain) {
    classification = "main";
  } else if (entry?.spawnedBy) {
    // Spawn ownership survives delivery-shaped keys; classify the child before
    // route parsing so clients do not present background work as a chat.
    classification = "subagent";
  } else if (isSubagentSessionKey(canonicalKey)) {
    classification = "subagent";
  } else if (isAcpSessionKey(canonicalKey)) {
    classification = "acp";
  } else if (isCronSessionKey(canonicalKey)) {
    classification = "cron";
  } else if (parsedThread.threadId) {
    classification = "thread";
  } else if (route?.peerKind === "group") {
    classification = "group";
  } else if (route?.peerKind === "channel") {
    classification = "channel";
  } else if (hasDirectPeer) {
    classification = "direct";
  } else if (
    entry?.chatType === "direct" ||
    entry?.chatType === "group" ||
    entry?.chatType === "channel"
  ) {
    classification = entry.chatType;
  } else {
    classification = classifyRest(rest);
  }

  const peerKind: SessionPeerKind | undefined =
    route?.peerKind === "dm" || hasLegacyDirectPeer ? "direct" : route?.peerKind;
  return {
    classification,
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    ...(route?.accountId ? { accountId: route.accountId } : {}),
    ...(peerKind ? { peerKind } : {}),
    isMain,
    isBackground: BACKGROUND_CLASSIFICATIONS.has(classification),
  };
}
