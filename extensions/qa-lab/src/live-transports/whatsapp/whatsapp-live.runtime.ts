// Qa Lab plugin module implements whatsapp live behavior.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  startWhatsAppQaDriverSession,
  type WhatsAppQaDriverObservedMessage,
  type WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { z } from "zod";
import { createQaArtifactRunId } from "../../artifact-run-id.js";
import { QA_EVIDENCE_FILENAME, buildLiveTransportEvidenceSummary } from "../../evidence-summary.js";
import { startQaGatewayChild } from "../../gateway-child.js";
import { startQaGatewayRpcClient } from "../../gateway-rpc-client.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import {
  assertApprovalDecisionResult,
  formatApprovalResultValue,
  readAcceptedApprovalRequestId,
} from "../shared/live-approval-result.js";
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  redactQaLiveLaneDetails,
} from "../shared/live-artifacts.js";
import { inferQaCredentialSource as inferWhatsAppCredentialSource } from "../shared/live-credential-source.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";

const execFileAsync = promisify(execFile);

type WhatsAppQaRuntimeEnv = {
  driverAuthArchiveBase64: string;
  driverPhoneE164: string;
  sutAuthArchiveBase64: string;
  sutPhoneE164: string;
  groupJid?: string;
};

type WhatsAppQaScenarioId =
  | "whatsapp-approval-exec-deny-native"
  | "whatsapp-approval-exec-group-reaction-native"
  | "whatsapp-approval-exec-reaction-native"
  | "whatsapp-agent-message-action-react"
  | "whatsapp-agent-message-action-upload-file"
  | "whatsapp-audio-preflight"
  | "whatsapp-broadcast-group-fanout"
  | "whatsapp-canary"
  | "whatsapp-group-allowlist-block"
  | "whatsapp-group-activation-always"
  | "whatsapp-group-agent-message-action-react"
  | "whatsapp-group-agent-message-action-upload-file"
  | "whatsapp-group-audio-gating"
  | "whatsapp-group-outbound-audio"
  | "whatsapp-group-outbound-media"
  | "whatsapp-group-outbound-poll"
  | "whatsapp-group-pending-history-context"
  | "whatsapp-group-reply-to-bot-triggers"
  | "whatsapp-group-reply-to-message"
  | "whatsapp-inbound-reaction-no-trigger"
  | "whatsapp-inbound-image-caption"
  | "whatsapp-inbound-structured-messages"
  | "whatsapp-message-actions"
  | "whatsapp-outbound-document-preserves-filename"
  | "whatsapp-outbound-media-matrix"
  | "whatsapp-outbound-poll"
  | "whatsapp-outbound-send-serialization"
  | "whatsapp-mention-gating"
  | "whatsapp-reply-delivery-shape"
  | "whatsapp-reply-context-isolation"
  | "whatsapp-reply-to-message"
  | "whatsapp-reply-to-mode-batched"
  | "whatsapp-stream-final-message-accounting"
  | "whatsapp-status-reaction-lifecycle"
  | "whatsapp-status-reactions"
  | "whatsapp-top-level-reply-shape"
  | "whatsapp-approval-exec-native"
  | "whatsapp-approval-plugin-native";

type WhatsAppQaApprovalKind = "exec" | "plugin";
type WhatsAppQaApprovalDecision = "allow-once" | "deny";
type WhatsAppQaApprovalDecisionMode = "reaction" | "rpc";
type WhatsAppQaScenarioPosture = "direct-gateway" | "native-approval" | "user-path";

function toWhatsAppQaError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatErrorMessage(error));
}

const WHATSAPP_QA_SCENARIO_POSTURES = {
  "whatsapp-agent-message-action-react": "user-path",
  "whatsapp-agent-message-action-upload-file": "user-path",
  "whatsapp-approval-exec-deny-native": "native-approval",
  "whatsapp-approval-exec-group-reaction-native": "native-approval",
  "whatsapp-approval-exec-native": "native-approval",
  "whatsapp-approval-exec-reaction-native": "native-approval",
  "whatsapp-approval-plugin-native": "native-approval",
  "whatsapp-audio-preflight": "user-path",
  "whatsapp-broadcast-group-fanout": "user-path",
  "whatsapp-canary": "user-path",
  "whatsapp-group-activation-always": "user-path",
  "whatsapp-group-allowlist-block": "user-path",
  "whatsapp-group-agent-message-action-react": "user-path",
  "whatsapp-group-agent-message-action-upload-file": "user-path",
  "whatsapp-group-audio-gating": "user-path",
  "whatsapp-group-outbound-audio": "direct-gateway",
  "whatsapp-group-outbound-media": "direct-gateway",
  "whatsapp-group-outbound-poll": "direct-gateway",
  "whatsapp-group-pending-history-context": "user-path",
  "whatsapp-group-reply-to-bot-triggers": "user-path",
  "whatsapp-group-reply-to-message": "user-path",
  "whatsapp-inbound-image-caption": "user-path",
  "whatsapp-inbound-reaction-no-trigger": "user-path",
  "whatsapp-inbound-structured-messages": "user-path",
  "whatsapp-mention-gating": "user-path",
  "whatsapp-message-actions": "direct-gateway",
  "whatsapp-outbound-document-preserves-filename": "direct-gateway",
  "whatsapp-outbound-media-matrix": "direct-gateway",
  "whatsapp-outbound-poll": "direct-gateway",
  "whatsapp-outbound-send-serialization": "direct-gateway",
  "whatsapp-reply-context-isolation": "direct-gateway",
  "whatsapp-reply-delivery-shape": "direct-gateway",
  "whatsapp-reply-to-message": "user-path",
  "whatsapp-reply-to-mode-batched": "user-path",
  "whatsapp-status-reaction-lifecycle": "user-path",
  "whatsapp-status-reactions": "user-path",
  "whatsapp-stream-final-message-accounting": "user-path",
  "whatsapp-top-level-reply-shape": "user-path",
} satisfies Record<WhatsAppQaScenarioId, WhatsAppQaScenarioPosture>;

type WhatsAppQaMessageSendMode =
  | {
      kind?: "text";
    }
  | {
      fileName?: string;
      kind: "media";
      mediaBuffer: Buffer;
      mediaType: string;
    };

type WhatsAppQaGateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
type WhatsAppQaGatewayRuntime = Pick<WhatsAppQaGateway, "call" | "restart" | "workspaceDir"> &
  Partial<Pick<WhatsAppQaGateway, "logs" | "token" | "wsUrl">>;
type WhatsAppQaGatewayCallContext = {
  gateway: Pick<WhatsAppQaGatewayRuntime, "call">;
  gatewayTarget: string;
  scenarioId: WhatsAppQaScenarioId;
  sutAccountId: string;
};
type WhatsAppQaObservedMessagesContext = {
  driver: Pick<WhatsAppQaDriverSession, "getObservedMessages">;
  sutPhoneE164: string;
  target: string;
  targetKind: "dm" | "group";
};
type WhatsAppQaDriverQuotedMessageKey = NonNullable<
  NonNullable<Parameters<WhatsAppQaDriverSession["sendText"]>[2]>["quotedMessageKey"]
>;

type WhatsAppQaMessageScenarioContext = {
  driver: WhatsAppQaDriverSession;
  driverPhoneE164: string;
  gateway: WhatsAppQaGatewayRuntime;
  gatewayTarget: string;
  gatewayWorkspaceDir: string;
  recordObservedMessage: (message: WhatsAppQaDriverObservedMessage) => void;
  requestStartedAt: Date;
  scenarioId: WhatsAppQaScenarioId;
  scenarioTitle: string;
  sent: { messageId?: string };
  sutAccountId: string;
  sutPhoneE164: string;
  target: string;
  targetKind: "dm" | "group";
  waitForReady: () => Promise<void>;
};

type WhatsAppQaResolvedScenarioTarget =
  | {
      target: "dm";
    }
  | {
      groupJid: string;
      target: "group";
    };

function resolveWhatsAppQaScenarioTarget(params: {
  groupJid?: string;
  scenarioId: WhatsAppQaScenarioId;
  target: "dm" | "group";
}): WhatsAppQaResolvedScenarioTarget {
  if (params.target === "dm") {
    return { target: "dm" };
  }
  if (!params.groupJid) {
    throw new Error(`WhatsApp scenario ${params.scenarioId} requires groupJid.`);
  }
  return {
    groupJid: params.groupJid,
    target: "group",
  };
}

function resolveWhatsAppQaMessageTargets(params: {
  driverPhoneE164: string;
  groupJid?: string;
  scenarioTarget: "dm" | "group";
  sutPhoneE164: string;
}) {
  if (params.scenarioTarget === "group") {
    if (!params.groupJid) {
      throw new Error("WhatsApp group scenario requires groupJid.");
    }
    return {
      driverTarget: params.groupJid,
      gatewayTarget: params.groupJid,
    };
  }
  return {
    driverTarget: params.sutPhoneE164,
    gatewayTarget: params.driverPhoneE164,
  };
}

type WhatsAppQaMessageScenarioRun = {
  afterReply?: (
    reply: WhatsAppQaDriverObservedMessage,
    context: WhatsAppQaMessageScenarioContext,
  ) => Promise<string | undefined> | string | undefined;
  afterSend?: (context: WhatsAppQaMessageScenarioContext) => Promise<string | undefined>;
  allowQuietWindowMessage?: (
    message: WhatsAppQaDriverObservedMessage,
    context: WhatsAppQaMessageScenarioContext,
  ) => boolean;
  configMode: "allowlist" | "disabled" | "open" | "pairing";
  expectReply: boolean;
  expectedJoinedSutTextIncludes?: string[];
  expectedSutMessageCount?: number;
  expectedSutMessageCountRange?: readonly [number, number];
  input: string;
  kind?: "message";
  matchText: string | RegExp;
  quietInput?: string;
  quietMatchText?: string | RegExp;
  quietSendMode?: WhatsAppQaMessageSendMode;
  quietWindowMs?: number;
  sendMode?: WhatsAppQaMessageSendMode;
  settleMs?: number;
  target: "dm" | "group";
  verify?: (
    reply: WhatsAppQaDriverObservedMessage,
    context: WhatsAppQaMessageScenarioContext,
  ) => void;
};

type WhatsAppQaApprovalScenarioRun = {
  approvalKind: WhatsAppQaApprovalKind;
  decision: WhatsAppQaApprovalDecision;
  decisionMode?: WhatsAppQaApprovalDecisionMode;
  kind: "approval";
  target?: "dm" | "group";
  token: string;
};

type WhatsAppQaScenarioRun = WhatsAppQaApprovalScenarioRun | WhatsAppQaMessageScenarioRun;

type WhatsAppQaConfigOverrides = {
  actions?: boolean;
  audioPreflight?: boolean;
  approvals?: {
    exec?: boolean;
    plugin?: boolean;
  };
  blockGroupSender?: boolean;
  broadcast?: {
    agents: string[];
    strategy?: "parallel" | "sequential";
  };
  groupHistoryLimit?: number;
  groupPolicy?: "allowlist" | "disabled" | "open";
  inboundDebounceMs?: number;
  replyToMode?: "all" | "batched" | "first" | "off";
  statusReactions?:
    | boolean
    | {
        removeAckAfterReply?: boolean;
        timing?: NonNullable<NonNullable<OpenClawConfig["messages"]>["statusReactions"]>["timing"];
      };
};

type WhatsAppQaScenarioDefinition = LiveTransportScenarioDefinition<WhatsAppQaScenarioId> & {
  buildRun: () => WhatsAppQaScenarioRun;
  configOverrides?: WhatsAppQaConfigOverrides;
  defaultEnabled?: boolean;
  defaultProviderModes?: readonly QaProviderMode[];
  requiresGroupJid?: boolean;
  requiredPluginIds?: readonly string[];
};

interface WhatsAppObservedMessage extends WhatsAppQaDriverObservedMessage {
  approvalState?: "pending" | "resolved";
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
}

type WhatsAppObservedMessageArtifact = {
  approvalState?: "pending" | "resolved";
  fromPhoneE164?: string | null;
  hasMedia?: boolean;
  kind?: WhatsAppQaDriverObservedMessage["kind"];
  matchedScenario?: boolean;
  mediaFileName?: string;
  mediaType?: string;
  messageId?: string;
  observedAt: string;
  poll?: WhatsAppQaDriverObservedMessage["poll"];
  quoted?: WhatsAppQaDriverObservedMessage["quoted"];
  reaction?: WhatsAppObservedReactionArtifact;
  scenarioId?: string;
  scenarioTitle?: string;
  text?: string;
};

type WhatsAppObservedReactionArtifact = {
  emoji?: string;
  fromMe?: boolean;
  messageId?: string;
  participant?: string;
};

type WhatsAppQaScenarioResult = {
  details: string;
  id: string;
  posture: WhatsAppQaScenarioPosture;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs: number;
    requestStartedAt: string;
    responseObservedAt: string;
    source: "approval-request-to-resolution" | "request-to-observed-message";
  };
  standardId?: string;
  status: "fail" | "pass" | "skip";
  title: string;
};

function buildWhatsAppQaScenarioResultBase(scenario: WhatsAppQaScenarioDefinition) {
  return {
    id: scenario.id,
    title: scenario.title,
    standardId: scenario.standardId,
    posture: WHATSAPP_QA_SCENARIO_POSTURES[scenario.id],
  };
}

function toWhatsAppLiveTransportEvidenceChecks(
  scenarioResults: readonly WhatsAppQaScenarioResult[],
) {
  return scenarioResults.map(({ standardId, ...check }) => ({
    ...check,
    coverageIds: standardId ? [`channels.whatsapp.${standardId}`] : undefined,
  }));
}

export type WhatsAppQaRunResult = {
  gatewayDebugDirPath?: string;
  observedMessagesPath: string;
  outputDir: string;
  reportPath: string;
  scenarios: WhatsAppQaScenarioResult[];
  summaryPath: string;
};

type WhatsAppCredentialLease = Awaited<
  ReturnType<typeof acquireQaCredentialLease<WhatsAppQaRuntimeEnv>>
>;
type WhatsAppCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;
type WhatsAppQaPreScenarioPhase =
  | "auth archive unpack"
  | "credential heartbeat start"
  | "credential lease acquisition"
  | "driver session start"
  | "scenario execution";

const WHATSAPP_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_WHATSAPP_CAPTURE_CONTENT";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS = 5;
const WHATSAPP_QA_READY_TIMEOUT_MS = 150_000;
const WHATSAPP_QA_READY_STABILITY_MS = 20_000;
const WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS = 10_000;
const WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS = 60_000;
const WHATSAPP_QA_ENV_KEYS = [
  "OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164",
  "OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164",
  "OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64",
  "OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64",
] as const;
const WHATSAPP_QA_ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzK4ZQAAAABJRU5ErkJggg==",
  "base64",
);
const WHATSAPP_QA_ONE_PIXEL_WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=",
  "base64",
);
const WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER = "WHATSAPP_QA_AUDIO_TRANSCRIPT_OK";
const WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER = "WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK";
const WHATSAPP_QA_AUDIO_OGG_OPUS_MIME = "audio/ogg; codecs=opus";
const WHATSAPP_QA_AUDIO_OGG_OPUS_BASE64 =
  "T2dnUwACAAAAAAAAAAB+ERNPAAAAAKrCWf4BE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAH4RE08BAAAAPue4fQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAAH4RE08CAAAA93T5sjIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA/j//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//k9nZ1MAAAB3AQAAAAAAfhETTwMAAAC4FnApMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD+P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+T2dnUwAAgDICAAAAAAB+ERNPBAAAAHzNb8IyAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP4//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//74//5PZ2dTAAAA7gIAAAAAAH4RE08FAAAAti6w9TIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA/j//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//vj//k9nZ1MAAICpAwAAAAAAfhETTwYAAADRd/qEMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD+P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+T2dnUwAEuKoDAAAAAAB+ERNPBwAAAPwDjSUBA/j//g==";
const WHATSAPP_QA_GROUP_AUDIO_TRIGGER_OGG_OPUS_BASE64 =
  "T2dnUwACAAAAAAAAAACs1H4/AAAAABj/cK0BE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAKzUfj8BAAAA6AtaXAFtT3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAIAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXMrAAAAREVTQ1JJUFRJT049T1BFTkNMQVdfUUFfR1JPVVBfQVVESU9fVFJJR0dFUk9nZ1MAAIC7AAAAAAAArNR+PwIAAACGY5phMkckGCUtIiEfIy8gIxwuLS4cGyQoIihMTE9PT1BPUFJSVFRXWVtfYWFhYWJhYWFhYmFhSIJZnkrDcAz+xAGMnThGX65XqGdfPIe0w4IO+SJAUxyiGdYAYUwZfOdWINkUyWuGjV1/P/954DorVwnwSTMo37USp7LVFMlIm26UDGiZ/D2DmvEYm2lDiuLcIWO21YuyYLNWaaAQ8XVyemBImb8vO4x33TOLv2CyTsrjQ+jIXRa1o45ImcJd/+z80UIJFD2jGgfpaB8GJkGHBVJ8G3KSHEQ/QhzhOaWYSJnCXfdf0v1Sq/lAxROgihfILbMfiqCgvr6L8NWKttQrCtV1NqTpONQ5LtUWSJm/Lzc3AQlWwaAU82jN9KAqGTRT63sKfY8Di6dd65x7gEiZwl5Q8g/Mmnm50BS31hPCf3eQn2B+WbtlJdp0uxH71EiZvy87jGzHyLEBqJ0RAiMTGms2kvCzIHm8NYiVqIBImcJd/+z80UILFd7vuc9OQN/jpHPGb6BN6/CkQnNyipzuI0iZwl33X9L9UqtGvHYtQxPuFAJ91yNxUZUduheyulH6M8OsB+slskJjWpa++R9wSJm/Lzc3AQlWwZ/IUJj84glb9YDV9Wk3tSycb1zfTtFImcJeUPIPzJp58SPxGQ1haVbcEF6fW6Im/oOB4C6lmmdMsEiZvy83NwEJVsGgVshiuOeeAljbAAHbvnpoC4BImcJd//SQlpMnr3LeCOb2BpKlBLDnt49f5UCEj0xKeO7BnQNwyvtauRPSYNngSJnCXfdf0v1SqYIak6j7ox1tR8QyNUgFsdBvmsZHMHY2OWlVmPn8na+kqd7WSJm/Lzc3AQlWwZ/Rj2FTgFi1MlW1FCkMMnURA7IJ1trk7F8VyEUF7kIbYeTQ8EiZwl5Q8g/Mmn4a4aO1aNxZuhCqKD0vYX/GCZ9Imb8vO4x33TOLvjf2YgzpAfH25djzIpN77fhImcJd/+z80UILFdw6g4Mwl5SSJGU0ejANsSxW9XCWTOq9PHBImcJd91/S/VKqVuM5tI8oJG4t8a+YQXCIiVNEvmX3G+pVBXkFxvf8SJm/Lzc3AQlWwaBtHDWAMLcJObv5GOzLpH+1nUKf7Ytm2kiaN287jHfdJXB7Z85RjZ2QBt4ma8wthvUnDB63+bgUHkR+lq5Or4BImjdvNzbzx8LOEapUMU6CDW7bm1PTQClhIroXz/g1IT72eWOOgX4aX7fxRV2AbUumvxRConpOcnn7je9W9Wt5nOrTejWZNo54/ySwuJw/XIkS3xEqkt17HBM37FRWBRzfE9pYNh2NDxtl8DWApFfrjWUVgB+pQbrPH6CW5M6RxUqWhbEd8rTFGjaM294W1Zxk+MnW4g8+17ic1oAPArTrYqESA1yfQWddX5F3KF5yIUhQHGitmuGRcTe3cWKEdHDICA1G/ZMIqaFDClQdqqEtxVnhZ4kHrL8UFyFoKlGKf8bytw9fa5e4nBmotUdrLiY4bP+mLEse3S7HndTSrS2fgL562uKe0HUk62cZvmB4dxSMs6RZAdPfpKdfuyJmsBNr1WzbvkVDLrNqe6Mb6dPyJWcUMOCXuJwQaP/Ld83BXXlEBmvRb1gZKJdGS3s9qkdjrHrSdqsnzWgFyoqeEn7zRqu/LUPQqkZPhXk2ToefXDEbhyrsoI4nvs8OhiZx8bVj/d17l7icHMRAubGJWypQh10EEOC9PgIQvBIHgiTvolH3H7kX6Se6qXH3ouZRw8ActzQf2boMVkPyGJEPNT4dZITaCcrhpaEjvGpc6x/Jk8pTdMCXuJztJ6iIEO3XKXQG8d8MrGCKg/Y7Ip++9DyysMJNyUMwYmoMYFfu4gPeYoN1Px79QfV43zBi3bhF30fTz6KyGzzojmd7w15D5Gmwke60l7ic7Sen4fyHKnvseVD1cCKO6VKP/bdSP1xfptNgToC0SE4M3LhLUo4wJRtV2ZUjmhQwqOrTeSX4Z07GorUFg0yPo1tlG1Cy/NPk0jxRRJWXuJwY91A/jc7kKxR7hYeBr4hAxjglt6bDCrKXPD64x1/mo6lisvak53oGW9AiLb9L0/Sa9nhaCU1gO2bGfN+ifqGRHbU90Y34VCS/Iq24H8JGl7icEGj/y3fNwV15RAZr0XJZpUGoz/iSH0T+6P9IsOMV67CKNrpsby0CQ1bVzLuyUKueSjIN6ek7/zlcJ0TDL5hSbxPfZ4dDFymLPpurH+9p5pe4nBzEQLmxiVsqUIddBA6Uyk+eKOmy5+xNTHklqEeIbErBChgqm/8BCkbuwBy3OkShHlooSMfEPnmkP44FcoKNsSYLlnnRbxqXK/DXHkZPKU3TAJe4nO0nqIgQ7dcpdAbx3wysYIqD9jsAR5aUkD9lY52xEDDbv1dpgpz2at4l3AqukFffxxbamb0kLmtwE9T18+DqPlGoKPnTcfs73hryHyWmwke6yJe4nO0np+H8hyp77HlQ9XAijulRrWCl1BVkex52OZCW5xSzsHFXKRBIjrZaUbYwxPRwmRECqHRxp5X55LycelTg/u+uON9sB7TCqbDahZfmnyVI8UUSXJe4nBj3UD+NzuQrFHuFh4G2YdB7xfw5ea3RIChjR8iwYwj/Kd0/NmI18mG2EyEDY1HgEvK6QFW9laY2l88LTVo2h1H2M/dUZfr17HdpPWL2doT8irZwH8JIl7icEGj/y3fNwV15RAZr0W7kwzp+J14p1HnYp264gAZdbEbDCpGKMeo2EakxkiWPOPXwpWiBfubGKOLILib1MNT/NvtwvnROdlgHSbR6I9EdBzZr9N1Yfd5p5Ze4nBzEQLmxiVsqUIddBBDS+10Zq3SsVaeBAynA3xXPT9szX+3rV5imE1C1IYsmGcatgPQY6j8u1ezklm/2IkHFOVd/AT/gPy0bP9xpRw0ycicpA7p58CvyMnylN6cAl7ic7SeoiBDt1yl0BvHfDKZ/FxRlsAn8KaaWBLj+YYQZOFdwwe9ft8/BmMuTKHX7zcgrD2CtsTql/vCxJDn0uQmVqrt0igC+B2vh3tZpiuR8alj3dJswy0p8/JabKR12yJe4nO0np+H8hyp77HlQ9XAxqDTuUoM2e0NZd1p7+64UbCjrOoPp+J62XwdWh1/hPdN05chTvi52IOsBS8Ta2z/hgiEf4ngPP/K9HBZdlCyMpnoxkMkCWZGgLfkqR40VIlyXuJwY91A/jc7kKxR7hYeBtnS0lPVdh/Gz2qz9L/P8AsRpYrcT39ehxqVx+GvparoIVHIIb/FuSjVpm47cPee1scd2azEC8VsT/2wGXQdr27QTn9oA7SQonzn5FWzgfoJGl7icEGj/y3fNwV15RAZr0W51P4xdHIuZZEE5wTlGXYN/m8uBQ7Gd+lqXLfVS6yRmSmwNStEOP5vU552b7yhmv15lLo6p0peZ4HhfT+YeEDQkY/Z1PvexFGqA/G6sP95p5Ze4nBzEQLmxiVsqUIddBBDSZI6g2ZTwgb9MYrqZCOMqBOkTrGGUc4tJb4JYXfnnt0nb/B9MOwW6j8u1eq5RZv9iJApbaky0tP1u2t7mfzUQTEht19Vrw7p5uRNyMnylN6cBl7ic7SeoiBDt1yl0BvHfDKZ+pmRpsAn8KaaWBLj+YYQZOFdwwe9ft8/BmMuTKHX7zcgrD2CtsTql/vCxJDn0uQmVqrt0igC+B2vh3tZpiuR8alj3dJswy0d8/JabCR12yJe4nO0np+H8hyp77HlQ9XAxqDTuUoM2e0NZd1p7+64UbCjrOoPp+J62XwdWh1/hPdN05chTvi52IOsBS8Ta2z/hgiEf4ngPP/K9HBZdlCyMpnoxkMkCWZGgLfkqR5EVIluXuJwY91A/jc7kKxR7hYeBtnS0lPVdh/Gz2qz9L/P8AsRpYrcT39ehxqVx+GvparoIVHIIb/FuSjVpm47cPee1scd2azEC8VsT/2wGXQdr27QTn9oA7SQonzn5FWzgfoJHl7icEGj/y3fNwV15RAZr0W51P4xdHIuZZEE5wTlGXYN/m8uBQ7Gd+lqXLfVS6yRmSmwNStEOP5vU552b7yhmv15lLo6p0peZ4HhfT+YeEDQkY/Z1PvexFGqA+m6sP95p5Ze4nBzEQLmxiVsqUIddBBDSZI6g2ZTwgb9MYrqZCOMqBOkTrGGUc4tJb4JYXfnnt0nb/B9MOwW6j8u1eq5RZv9iJApbaky0tP1u2t7mfzUQTEht19Vrw7p5uRNyMnylN6cBl7ic7SeoiBDt1yl0BvHfDKZ+pmRpsAn8KaaWBLj+YYQZOFdwwe9ft8/BmMuTKHX7zcgrD2CtsTql/vCxJDn0uQmVqrt0igC+B2vh3tZpiuR8alj3dJswy0d8/JabKR12yJe4nO0np+H8hyp77HlQ9XAxqDTuUoM2e0NZd1p7+64UbCjrOoPp+J62XwdWh1/hPdN05chTvi52IOsBS8Ta2z/hgiEf4ngPP/K9HBZdlCyMpnoxkMkCWZGgLfkqR40VIluXT2dnUwAEOOIAAAAAAACs1H4/AwAAAIiIgYcLYWFiYWFhYWJgYHO4nBj3UD+NzuQrFHuFh4G2dLSU9V2H8bParP0v8/wCxGlitxPf16HGpXH4a+lqughUcghv8W5KNWmbjtw957Wxx3ZrMQLxWxP/bAZdB2vbtBOf2gDtJCifOfkVbOB+gkeXuJwQaP/Ld83BXXlEBmvRbnU/jF0ci5lkQTnBOUZdg3+by4FDsZ36Wpct9VLrJGZKbA1K0Q4/m9TnnZvvKGa/XmUujqnSl5ngeF9P5h4QNCRj9nU+97EUaoD8bqw/3mnll7icHMRAubGJWypQh10EENJkjqDZlPCBv0xiupkI4yoE6ROsYZRzi0lvglhd+ee3Sdv8H0w7BbqPy7V6rlFm/2IkCltqTLS0/W7a3uZ/NRBMSG3X1WvDunm5E3IyfKU3pwGXuJztJ6iIEO3XKXQG8d8Mpjj5jGWwCfsNPoIEuP5hhBk4V3DCAPePz8FtEHZodfvNyCp9x02xOqdxs26kOfS7SZWqu3SKAL4Ha+He1mmK5Hxt1vd0mvDLZGf8lpspHXa5l7ic7Sen4fyHKnvseVD1cDGoNO5SgzZ7Q1l3Wnv7rhRsKOs6g+n4nrZfB1aHX+E903TlyFO+LnYg6wFLxNrbP+GCIR/ieA8/8r0cFl2ULIymejGQyQJZkaAt+SpHURUia5e4nBj3UD+NzuQrFHuFh4G2dLSU9V2H8bParP0v8/wCxGlitxPf16HGpXH4a+lqughUcghv8W5KNWmbjtw957Wxx3ZrMQLxWxP/bAZdB2vbtBOf2gDtJCifOfkVbOB+gkaXuJwQaP/Ld83BXXlEBmvRbnU/jF0ci5brtLHBOUZdg3+by4FDsZ36Wpct9VLrJGZKbA1K0Q4/m9TnnZvvKGa/XmUujqnSl5ngeF9P5h4QNCRjtPU+97FT6oD6bqw/3mnml7icHMRAubGJWypQh10EENJkjqDZlPCBv0xiupkI4yoE6ROsYZRzi0lvglhd+ee3Sdv8H0w7BbqPy7V6rlFm/2IkCltqTLS0/W7a3uZ/NRBMSG3X1WvDunm5E3IyfKU3owCXuJztJ6iIEO3XKXQG8d8Mpn7QOihya8QSyQVLCVBzE+C64r7xhjlO8BCw6Ukzr8fKkX3zj3cFdLDQb1Ic+lyEytVdukUG3Mtr4d7WaYo3fG4c93QesMtrfPyWmykddsiXuJztJ6fiCX3oNNfL/qg9gAERy4CM7Um+nF3YdJUYlWdR38OLFb7pyTvwRaPT3Qxsvs50kXu5gYZQgotrbD/hgiEf4ngPG3o5pk2XZQs8KZ6MZDJAlmRoC0pakeUVIlyXuJ+uKOGNfJinGHoqli86GdmVm0y1pdriEe46aAHrlIzbtHWRe0rUskk2HwjzvAE5F36LsUJPaW6rePwcRIUbsl8xelOlzLKP16exkpLXgxCjlT4WCZcrOZxoRNPBpix1EcEClpTdRx+cMgfY8xo65UCvlw==";
const WHATSAPP_QA_SIGNAL_SESSION_FILE_RE = /^session-[^/\\]+\.json$/u;

function createWhatsAppQaPdfBuffer() {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj",
      "<< /Type /Catalog /Pages 2 0 R >>",
      "endobj",
      "2 0 obj",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "endobj",
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
      "endobj",
      "trailer",
      "<< /Root 1 0 R >>",
      "%%EOF",
      "",
    ].join("\n"),
    "utf8",
  );
}

type WhatsAppStructuredInboundDriver = Pick<
  WhatsAppQaDriverSession,
  "sendContact" | "sendLocation" | "sendMedia" | "sendSticker"
>;

async function runWhatsAppStructuredInboundChecks(params: {
  contactToken: string;
  documentToken: string;
  driver: WhatsAppStructuredInboundDriver;
  driverPhoneE164: string;
  locationToken: string;
  stickerToken: string;
  target: string;
  waitForStructuredReply: (
    label: string,
    observedAfter: Date,
    expectedToken: string,
  ) => Promise<unknown>;
}) {
  const documentStartedAt = new Date();
  await params.driver.sendMedia(
    params.target,
    `Reply with only this exact marker after reading the document caption: ${params.documentToken}`,
    createWhatsAppQaPdfBuffer(),
    "application/pdf",
    { fileName: "whatsapp-qa-document.pdf" },
  );
  await params.waitForStructuredReply("document", documentStartedAt, params.documentToken);

  const locationStartedAt = new Date();
  await params.driver.sendLocation(params.target, {
    degreesLatitude: 37.7749,
    degreesLongitude: -122.4194,
  });
  await params.waitForStructuredReply("location", locationStartedAt, params.locationToken);

  const contactStartedAt = new Date();
  const driverContactWaId = params.driverPhoneE164.replace(/\D/g, "");
  await params.driver.sendContact(params.target, {
    displayName: "WhatsApp QA Driver Contact",
    vcard: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:WhatsApp QA Driver Contact",
      `TEL;type=CELL;type=VOICE;waid=${driverContactWaId}:${params.driverPhoneE164}`,
      "END:VCARD",
    ].join("\n"),
  });
  await params.waitForStructuredReply("contact", contactStartedAt, params.contactToken);

  const stickerStartedAt = new Date();
  await params.driver.sendSticker(params.target, WHATSAPP_QA_ONE_PIXEL_WEBP, {
    mimetype: "image/webp",
  });
  await params.waitForStructuredReply("sticker", stickerStartedAt, params.stickerToken);
}

function createWhatsAppQaAudioWavBuffer(params?: { durationSeconds?: number }) {
  const sampleRate = 16_000;
  const channelCount = 1;
  const bitsPerSample = 16;
  const durationSeconds = params?.durationSeconds ?? 1;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = sampleRate * durationSeconds * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function createWhatsAppQaAudioOggOpusBuffer(params?: { variant?: "default" | "group-trigger" }) {
  return Buffer.from(
    params?.variant === "group-trigger"
      ? WHATSAPP_QA_GROUP_AUDIO_TRIGGER_OGG_OPUS_BASE64
      : WHATSAPP_QA_AUDIO_OGG_OPUS_BASE64,
    "base64",
  );
}

const whatsappQaCredentialPayloadSchema = z.object({
  driverPhoneE164: z.string().trim().min(1),
  sutPhoneE164: z.string().trim().min(1),
  driverAuthArchiveBase64: z.string().trim().min(1),
  sutAuthArchiveBase64: z.string().trim().min(1),
  groupJid: z.string().trim().min(1).optional(),
});

function buildWhatsAppQuoteReplyRun(target: "dm" | "group"): WhatsAppQaMessageScenarioRun {
  const token = `WHATSAPP_QA_REPLY_TO_${target.toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const input =
    target === "group"
      ? `openclawqa reply with only this exact marker: ${token}`
      : `Reply with only this exact marker: ${token}`;
  return {
    configMode: "allowlist",
    expectReply: true,
    input,
    matchText: token,
    target,
    verify: (reply, context) => {
      if (!context.sent.messageId) {
        throw new Error("WhatsApp driver did not return a triggering message id.");
      }
      if (reply.quoted?.messageId !== context.sent.messageId) {
        throw new Error(
          `expected reply quote ${context.sent.messageId}, got ${reply.quoted?.messageId ?? "<missing>"}`,
        );
      }
    },
  };
}

const WHATSAPP_QA_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  {
    id: "whatsapp-canary",
    standardId: "canary",
    title: "WhatsApp DM canary",
    timeoutMs: 60_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-mention-gating",
    standardId: "mention-gating",
    title: "WhatsApp group mention gating",
    timeoutMs: 60_000,
    requiresGroupJid: true,
    buildRun: () => {
      const quietToken = `WHATSAPP_QA_GROUP_QUIET_${randomUUID().slice(0, 8).toUpperCase()}`;
      const replyToken = `WHATSAPP_QA_GROUP_MENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker: ${replyToken}`,
        matchText: replyToken,
        quietInput: `This group message is intentionally unmentioned. If you respond, include ${quietToken}.`,
        quietMatchText: quietToken,
        quietWindowMs: 5_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-pending-history-context",
    title: "WhatsApp group pending history reaches mentioned turns",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      groupHistoryLimit: 50,
      groupPolicy: "open",
      inboundDebounceMs: 0,
      replyToMode: "all",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const quietMarker = `WHATSAPP_QA_PENDING_HISTORY_QUIET_${suffix}`;
      const contextSentinel = `WHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_${suffix}`;
      const triggerMarker = `WHATSAPP_QA_PENDING_HISTORY_TRIGGER_${suffix}`;
      const okMarker = `WHATSAPP_QA_PENDING_HISTORY_OK_${suffix}`;
      return {
        configMode: "open",
        expectReply: true,
        expectedSutMessageCount: 1,
        input:
          `openclawqa pending history context check ${triggerMarker}. ` +
          `Reply with only ${okMarker} only if the previous quiet group message containing ` +
          `${quietMarker} is present in prior group context with its context-only sentinel. ` +
          "Do not use current-message text as proof.",
        matchText: okMarker,
        quietInput: `quiet context marker ${quietMarker} ${contextSentinel}`,
        quietWindowMs: 5_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-broadcast-group-fanout",
    title: "WhatsApp group broadcast fans out to multiple agents",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      broadcast: {
        agents: ["main", "qa-second"],
        strategy: "sequential",
      },
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_BROADCAST_TOKEN_${randomUUID().slice(0, 8).toUpperCase()}`;
      const mainMarker = `${token}_MAIN`;
      const secondMarker = `${token}_SECOND`;
      return {
        afterReply: async (reply, context) => {
          const replies = await waitForDistinctWhatsAppSutMessages(context, {
            initialMessages: [reply],
            matchers: [
              (message) => message.text.includes(mainMarker),
              (message) => message.text.includes(secondMarker),
            ],
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
          });
          assertWhatsAppMessagesFromSutPhone(replies, context);
          return "broadcast fanout produced main and qa-second replies";
        },
        configMode: "open",
        expectReply: true,
        input: `openclawqa broadcast fanout check ${token}`,
        matchText: mainMarker,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-activation-always",
    title: "WhatsApp group activation always wakes unmentioned messages",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const alwaysMarker = `WHATSAPP_QA_ACTIVATION_ALWAYS_${suffix}`;
      const quietMarker = `WHATSAPP_QA_ACTIVATION_QUIET_${suffix}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          let activationProbeError: unknown;
          try {
            const alwaysStartedAt = new Date();
            await context.driver.sendText(
              context.target,
              `Group activation visible behavior marker ${alwaysMarker}`,
            );
            const alwaysReply = await waitForWhatsAppScenarioSutMessage(context, {
              match: (message) => message.text.includes(alwaysMarker),
              observedAfter: alwaysStartedAt,
              targetKind: "group",
              timeoutMs: 60_000,
            });
            assertWhatsAppMessageFromSutPhone(alwaysReply, context);
          } catch (error) {
            activationProbeError = error;
          }

          let restoreError: unknown;
          const restoreStartedAt = new Date();
          try {
            await context.driver.sendText(context.target, "/activation mention");
            const restoreReply = await waitForWhatsAppScenarioSutMessage(context, {
              match: (message) => /\bactivation\b.*\bmention\b/iu.test(message.text),
              observedAfter: restoreStartedAt,
              targetKind: "group",
              timeoutMs: 60_000,
            });
            assertWhatsAppMessageFromSutPhone(restoreReply, context);
          } catch (error) {
            restoreError = error;
          }

          if (activationProbeError && restoreError) {
            throw new Error(
              `activation always probe failed; additionally failed to restore mention mode: ${formatErrorMessage(restoreError)}`,
              { cause: activationProbeError },
            );
          }
          if (activationProbeError) {
            throw toWhatsAppQaError(activationProbeError);
          }
          if (restoreError) {
            throw toWhatsAppQaError(restoreError);
          }

          const quietStartedAt = new Date();
          await context.driver.sendText(
            context.target,
            `Group activation quiet marker ${quietMarker}`,
          );
          await waitForNoWhatsAppReply({
            driver: context.driver,
            observedAfter: quietStartedAt,
            sutPhoneE164: context.sutPhoneE164,
            windowMs: 5_000,
            ...resolveWhatsAppQaNoReplyTarget({
              groupJid: context.target,
              target: "group",
            }),
          });
          return "activation always replied to an unmentioned group message and mention mode was restored";
        },
        configMode: "allowlist",
        expectReply: true,
        input: "/activation always",
        matchText: /\bactivation\b.*\balways\b/iu,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-reply-to-bot-triggers",
    title: "WhatsApp group reply to bot wakes without an explicit mention",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const seedMarker = `WHATSAPP_QA_REPLY_TO_BOT_SEED_${suffix}`;
      const triggerMarker = `WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_${suffix}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          const quotedStartedAt = new Date();
          const quotedTrigger = await context.driver.sendText(
            context.target,
            `Quoted implicit reply trigger marker ${triggerMarker}`,
            {
              quotedMessageKey: buildWhatsAppQuotedMessageKeyFromObservedMessage(reply, {
                remoteJid: context.target,
              }),
            },
          );
          if (!quotedTrigger.messageId) {
            throw new Error("WhatsApp driver did not return a quoted trigger message id.");
          }
          const quotedTriggerMessageId = quotedTrigger.messageId;
          const quotedReply = await waitForWhatsAppScenarioSutMessage(context, {
            diagnosticChecks: [
              {
                label: "containsTriggerMarker",
                match: (message) => message.text.includes(triggerMarker),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.text.includes(triggerMarker) &&
              message.quoted?.messageId === quotedTriggerMessageId,
            observedAfter: quotedStartedAt,
            targetKind: "group",
            timeoutMs: 60_000,
          });
          assertWhatsAppMessageFromSutPhone(quotedReply, context);
          return "quoted reply to bot triggered a group response without an explicit mention";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa Mentioned group seed marker ${seedMarker}`,
        matchText: seedMarker,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-top-level-reply-shape",
    standardId: "top-level-reply-shape",
    title: "WhatsApp DM top-level reply shape",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "off",
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_TOP_LEVEL_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker: ${token}`,
        matchText: token,
        target: "dm",
        verify: (reply) => {
          if (reply.quoted?.messageId) {
            throw new Error(
              `expected top-level WhatsApp reply without quote metadata, got quoted message ${reply.quoted.messageId}`,
            );
          }
        },
      };
    },
  },
  {
    id: "whatsapp-reply-to-message",
    standardId: "quote-reply",
    title: "WhatsApp DM reply-to mode quotes the triggering message",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "all",
    },
    buildRun: () => buildWhatsAppQuoteReplyRun("dm"),
  },
  {
    id: "whatsapp-group-reply-to-message",
    standardId: "quote-reply",
    title: "WhatsApp group reply-to mode quotes the triggering message",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "all",
    },
    requiresGroupJid: true,
    buildRun: () => buildWhatsAppQuoteReplyRun("group"),
  },
  {
    id: "whatsapp-reply-to-mode-batched",
    title: "WhatsApp batched reply-to mode quotes the queued message",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      inboundDebounceMs: 250,
      replyToMode: "batched",
    },
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const firstToken = `WHATSAPP_QA_BATCHED_FIRST_${suffix}`;
      const finalToken = `WHATSAPP_QA_BATCHED_FINAL_${suffix}`;
      let secondMessageId: string | undefined;
      return {
        afterSend: async (context) => {
          const second = await context.driver.sendText(
            context.target,
            `Second batched WhatsApp QA message. Reply with only this exact marker: ${finalToken} only if the previous queued message is visible in this same run context.`,
          );
          secondMessageId = second.messageId;
          return "second batched message sent before debounce flush";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `First batched WhatsApp QA message ${firstToken}. Wait for the next message before replying.`,
        matchText: finalToken,
        target: "dm",
        verify: (reply) => {
          if (!secondMessageId) {
            throw new Error("WhatsApp driver did not return a second batched message id.");
          }
          if (reply.quoted?.messageId !== secondMessageId) {
            throw new Error(
              `expected batched reply quote ${secondMessageId}, got ${reply.quoted?.messageId ?? "<missing>"}`,
            );
          }
        },
      };
    },
  },
  {
    id: "whatsapp-agent-message-action-react",
    title: "WhatsApp user-path agent reaction uses the message tool",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_AGENT_REACT_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            timeoutMs: 60_000,
          });
          return `agent message reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message, context) =>
          matchesWhatsAppSutReactionToTrigger(message, context, { emoji: "👍" }),
        configMode: "allowlist",
        expectReply: false,
        input:
          `React to this WhatsApp message with thumbs up for QA action check ${token}. ` +
          "Do not send any visible text reply after the reaction.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-agent-message-action-upload-file",
    title: "WhatsApp user-path agent upload-file sends media",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_AGENT_UPLOAD_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const media = await waitForScenarioObservedMessage(context, {
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(token),
          });
          return `agent upload-file media ${media.mediaType ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message) =>
          message.kind === "media" &&
          message.mediaType?.startsWith("image/") === true &&
          message.text.includes(token),
        configMode: "allowlist",
        expectReply: false,
        input:
          `Use the WhatsApp message tool upload-file action to send a PNG with caption ${token}. ` +
          "Do not send any visible text reply after the upload.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-agent-message-action-react",
    title: "WhatsApp group user-path agent reaction uses the message tool",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_AGENT_REACT_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            timeoutMs: 60_000,
          });
          return `group agent message reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message, context) =>
          matchesWhatsAppSutReactionToTrigger(message, context, { emoji: "👍" }),
        configMode: "allowlist",
        expectReply: false,
        input:
          `openclawqa react to this WhatsApp group message with thumbs up for QA action check ${token}. ` +
          "Do not send any visible text reply after the reaction.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-agent-message-action-upload-file",
    title: "WhatsApp group user-path agent upload-file sends media",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_AGENT_UPLOAD_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const media = await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: context.requestStartedAt,
            targetKind: "group",
            timeoutMs: 60_000,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(token),
          });
          return `group agent upload-file media ${media.mediaType ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message) =>
          message.kind === "media" &&
          message.mediaType?.startsWith("image/") === true &&
          message.text.includes(token),
        configMode: "allowlist",
        expectReply: false,
        input:
          `openclawqa use the WhatsApp message tool upload-file action to send a PNG with caption ${token}. ` +
          "Do not send any visible text reply after the upload.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-inbound-reaction-no-trigger",
    title: "WhatsApp inbound user reaction does not start a fresh run",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_INBOUND_REACTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          if (!reply.messageId) {
            throw new Error("WhatsApp SUT reply did not include a message id to react to.");
          }
          const reactionStartedAt = new Date();
          await context.driver.sendReaction(context.target, reply.messageId, "❤️", {
            fromMe: false,
          });
          await waitForNoWhatsAppReply({
            driver: context.driver,
            observedAfter: reactionStartedAt,
            sutPhoneE164: context.sutPhoneE164,
            target: "dm",
            windowMs: 5_000,
          });
          return "driver reaction to SUT message did not trigger a fresh reply";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before inbound reaction check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-reply-context-isolation",
    title: "WhatsApp direct Gateway send does not reuse prior quote context",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_REPLY_ISOLATION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          if (!context.sent.messageId) {
            throw new Error("WhatsApp driver did not return a triggering message id.");
          }
          const quotedStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "quoted",
            message: `${token}_QUOTED`,
            replyToId: context.sent.messageId,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: quotedStartedAt,
            diagnosticChecks: [
              {
                label: "textMarker",
                match: (message) => message.text.includes(`${token}_QUOTED`),
              },
              {
                label: "quotedMessageIdMatchesTrigger",
                match: (message) => message.quoted?.messageId === context.sent.messageId,
              },
            ],
            match: (message) =>
              message.text.includes(`${token}_QUOTED`) &&
              message.quoted?.messageId === context.sent.messageId,
          });

          const freshStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "fresh",
            message: `${token}_FRESH`,
          });
          const fresh = await waitForScenarioObservedMessage(context, {
            observedAfter: freshStartedAt,
            match: (message) => message.text.includes(`${token}_FRESH`),
          });
          if (fresh.quoted?.messageId) {
            throw new Error(
              `expected fresh WhatsApp send without quote metadata, got quoted message ${fresh.quoted.messageId}`,
            );
          }
          return "quoted send and fresh send used independent reply context";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before reply isolation checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-inbound-image-caption",
    title: "WhatsApp inbound image caption reaches the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 60_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_IMAGE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `This image caption asks you to reply with only this exact marker: ${token}`,
        matchText: token,
        sendMode: {
          fileName: "whatsapp-qa.png",
          kind: "media",
          mediaBuffer: WHATSAPP_QA_ONE_PIXEL_PNG,
          mediaType: "image/png",
        },
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-audio-preflight",
    title: "WhatsApp inbound audio preflight transcript reaches the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      audioPreflight: true,
    },
    requiredPluginIds: ["openai"],
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER,
      sendMode: {
        fileName: "whatsapp-qa-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "dm",
    }),
  },
  {
    id: "whatsapp-outbound-media-matrix",
    title: "WhatsApp direct Gateway send delivers outbound media variants",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_OUTBOUND_MEDIA_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const mediaRootToken = randomUUID().slice(0, 8);
          const imagePath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: WHATSAPP_QA_ONE_PIXEL_PNG,
            fileName: `whatsapp-qa-${mediaRootToken}.png`,
          });
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-${mediaRootToken}.pdf`,
          });
          const audioPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaAudioWavBuffer(),
            fileName: `whatsapp-qa-${mediaRootToken}.wav`,
          });

          const imageStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "image",
            mediaUrl: imagePath,
            message: `${token}_IMAGE`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: imageStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_IMAGE`),
          });

          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "document",
            mediaUrl: documentPath,
            message: `${token}_DOCUMENT`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: documentStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true) &&
              message.text.includes(`${token}_DOCUMENT`),
          });

          const audioStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            asVoice: true,
            label: "audio",
            mediaUrl: audioPath,
            message: `${token}_AUDIO`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: audioStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("audio/") === true,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: audioStartedAt,
            match: (message) => message.text.includes(`${token}_AUDIO`),
          });

          const multiStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "multi",
            mediaUrls: [imagePath, documentPath],
            message: `${token}_MULTI`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: multiStartedAt,
            match: (message) =>
              message.kind === "media" && message.mediaType?.startsWith("image/") === true,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: multiStartedAt,
            match: (message) =>
              message.kind === "media" &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true),
          });
          return "gateway send delivered image, document, audio, and multi-media";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before outbound media checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-outbound-document-preserves-filename",
    title: "WhatsApp direct Gateway document preserves filename and caption",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_DOCUMENT_FILE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-report-${token}.pdf`,
          });
          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "document-filename",
            mediaUrl: documentPath,
            message: `${token}_CAPTION`,
          });
          const document = await waitForScenarioObservedMessage(context, {
            observedAfter: documentStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.text.includes(`${token}_CAPTION`) &&
              message.mediaFileName === `whatsapp-qa-report-${token}.pdf`,
          });
          return `document ${document.mediaFileName ?? "<missing filename>"} preserved`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before document filename check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-outbound-send-serialization",
    title: "WhatsApp parallel Gateway sends deliver every outbound message",
    defaultEnabled: false,
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_SERIAL_SEND_${randomUUID().slice(0, 8).toUpperCase()}`;
      const markers = Array.from({ length: 5 }, (_, index) => `${token}_${index + 1}`);
      return {
        afterReply: async (_reply, context) => {
          const sendsStartedAt = new Date();
          await callWhatsAppGatewaySendConcurrently(
            context,
            markers.map((marker, index) => ({
              label: `parallel-${index + 1}`,
              message: marker,
            })),
          );
          await Promise.all(
            markers.map((marker) =>
              waitForScenarioObservedMessage(context, {
                observedAfter: sendsStartedAt,
                match: (message) => message.kind === "text" && message.text.includes(marker),
              }),
            ),
          );
          return `gateway parallel send delivered ${markers.length}/${markers.length} messages`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before parallel send checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-outbound-poll",
    title: "WhatsApp direct Gateway poll delivers outbound native poll",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_OUTBOUND_POLL_${randomUUID().slice(0, 8).toUpperCase()}`;
      const question = `${token} choose one`;
      return {
        afterReply: async (_reply, context) => {
          const pollStartedAt = new Date();
          await callWhatsAppGatewayPoll(context, {
            label: "poll",
            options: ["alpha", "beta"],
            question,
          });
          const poll = await waitForScenarioObservedMessage(context, {
            observedAfter: pollStartedAt,
            match: (message) =>
              message.kind === "poll" &&
              message.poll?.question === question &&
              message.poll.options.includes("alpha") &&
              message.poll.options.includes("beta"),
          });
          return `poll observed with ${poll.poll?.options.length ?? 0} options`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before outbound poll check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-media",
    title: "WhatsApp direct Gateway send delivers media to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_MEDIA_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const mediaRootToken = randomUUID().slice(0, 8);
          const imagePath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: WHATSAPP_QA_ONE_PIXEL_PNG,
            fileName: `whatsapp-qa-group-${mediaRootToken}.png`,
          });
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-group-${mediaRootToken}.pdf`,
          });

          const imageStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "group-image",
            mediaUrl: imagePath,
            message: `${token}_IMAGE`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: imageStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_IMAGE`),
          });

          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "group-document",
            mediaUrl: documentPath,
            message: `${token}_DOCUMENT`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: documentStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true) &&
              message.text.includes(`${token}_DOCUMENT`),
          });
          return "gateway send delivered image and document media to the group";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound media checks: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-audio",
    title: "WhatsApp direct Gateway send delivers audio to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_AUDIO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const audioPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaAudioOggOpusBuffer({ variant: "group-trigger" }),
            fileName: `whatsapp-qa-group-audio-${token}.ogg`,
          });
          const audioStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            asVoice: true,
            label: "group-audio",
            mediaUrl: audioPath,
            message: `${token}_AUDIO`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: audioStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("audio/") === true,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: audioStartedAt,
            targetKind: "group",
            match: (message) => message.text.includes(`${token}_AUDIO`),
          });
          return "gateway send delivered audio media to the group";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound audio check: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-poll",
    title: "WhatsApp direct Gateway poll delivers native poll to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_POLL_${randomUUID().slice(0, 8).toUpperCase()}`;
      const question = `${token} choose one`;
      return {
        afterReply: async (_reply, context) => {
          const pollStartedAt = new Date();
          await callWhatsAppGatewayPoll(context, {
            label: "group-poll",
            options: ["alpha", "beta"],
            question,
          });
          const poll = await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: pollStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "poll" &&
              message.poll?.question === question &&
              message.poll.options.includes("alpha") &&
              message.poll.options.includes("beta"),
          });
          return `group poll observed with ${poll.poll?.options.length ?? 0} options`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound poll check: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-message-actions",
    title: "WhatsApp direct Gateway message.action react and upload-file execute",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_ACTIONS_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const triggerMessageId = requireWhatsAppTriggerMessageId(context);
          const reactionStartedAt = new Date();
          await callWhatsAppGatewayMessageAction(context, {
            action: "react",
            label: "react",
            params: {
              emoji: "👍",
              messageId: triggerMessageId,
            },
          });
          await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            observedAfter: reactionStartedAt,
          });

          const uploadStartedAt = new Date();
          await callWhatsAppGatewayMessageAction(context, {
            action: "upload-file",
            label: "upload-file",
            params: {
              buffer: WHATSAPP_QA_ONE_PIXEL_PNG.toString("base64"),
              caption: `${token}_UPLOAD`,
              contentType: "image/png",
              filename: "whatsapp-qa-upload.png",
            },
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: uploadStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_UPLOAD`),
          });
          return "message.action react and upload-file observed";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before action checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-inbound-structured-messages",
    title: "WhatsApp inbound structured messages reach the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 240_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_STRUCTURED_${randomUUID().slice(0, 8).toUpperCase()}`;
      const locationToken = `${token}_LOCATION`;
      const contactToken = `${token}_CONTACT`;
      const stickerToken = `${token}_STICKER`;
      const locationCoordinateText = "37.774900, -122.419400";
      return {
        afterReply: async (_reply, context) => {
          const waitForStructuredReply = async (
            label: string,
            observedAfter: Date,
            expectedToken: string,
          ) => {
            try {
              return await waitForScenarioObservedMessage(context, {
                observedAfter,
                timeoutMs: 60_000,
                match: (message) => message.text.includes(expectedToken),
                diagnosticChecks: [
                  {
                    label: "containsExpectedToken",
                    match: (message) => message.text.includes(expectedToken),
                  },
                ],
              });
            } catch (error) {
              throw new Error(
                `timed out waiting for WhatsApp structured ${label} reply (${expectedToken}): ${formatErrorMessage(error)}`,
                { cause: error },
              );
            }
          };

          await runWhatsAppStructuredInboundChecks({
            contactToken,
            documentToken: `${token}_DOCUMENT`,
            driver: context.driver,
            driverPhoneE164: context.driverPhoneE164,
            locationToken,
            stickerToken,
            target: context.target,
            waitForStructuredReply,
          });
          return "document, location, contact, and sticker elicited replies";
        },
        configMode: "allowlist",
        expectReply: true,
        input:
          `When a later WhatsApp location message shows ${locationCoordinateText}, ` +
          `reply with only this WhatsApp location marker: ${locationToken}. ` +
          `When a later WhatsApp contact message appears, ` +
          `reply with only this WhatsApp contact marker: ${contactToken}. ` +
          `When a later WhatsApp sticker message appears, ` +
          `reply with only this WhatsApp sticker marker: ${stickerToken}. ` +
          `Reply with only this exact marker before structured inbound checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-audio-gating",
    title: "WhatsApp group audio mention gating",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      audioPreflight: true,
    },
    requiredPluginIds: ["openai"],
    requiresGroupJid: true,
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER,
      quietInput: "",
      quietSendMode: {
        fileName: "whatsapp-qa-group-audio-quiet.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      quietWindowMs: 5_000,
      sendMode: {
        fileName: "whatsapp-qa-group-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer({
          variant: "group-trigger",
        }),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "group",
    }),
  },
  {
    id: "whatsapp-reply-delivery-shape",
    title: "WhatsApp direct Gateway send chunks long replies",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_REPLY_SHAPE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          if (!context.sent.messageId) {
            throw new Error("WhatsApp driver did not return a triggering message id.");
          }
          const quotedTriggerMessageId = context.sent.messageId;
          const chunkStartedAt = new Date();
          const longText = `${token}_LONG_BEGIN\n${"A".repeat(4_500)}\n${token}_LONG_END`;
          await callWhatsAppGatewaySend(context, {
            label: "long-reply",
            message: longText,
            replyToId: quotedTriggerMessageId,
          });
          const firstChunk = await waitForScenarioObservedMessage(context, {
            observedAfter: chunkStartedAt,
            diagnosticChecks: [
              {
                label: "longBeginMarker",
                match: (message) => message.text.includes(`${token}_LONG_BEGIN`),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.text.includes(`${token}_LONG_BEGIN`) &&
              message.quoted?.messageId === quotedTriggerMessageId,
          });
          const secondChunk = await waitForScenarioObservedMessage(context, {
            observedAfter: chunkStartedAt,
            diagnosticChecks: [
              {
                label: "longEndMarker",
                match: (message) => message.text.includes(`${token}_LONG_END`),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.messageId !== firstChunk.messageId &&
              message.text.includes(`${token}_LONG_END`) &&
              message.quoted?.messageId === quotedTriggerMessageId,
          });
          return `long reply chunked across ${firstChunk.messageId ?? "<first>"} and ${secondChunk.messageId ?? "<second>"}`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before reply-shape checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-stream-final-message-accounting",
    title: "WhatsApp streamed final response has exactly the final chunks",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      expectedJoinedSutTextIncludes: ["WHATSAPP-LONG-FINAL-BEGIN", "WHATSAPP-LONG-FINAL-END"],
      expectedSutMessageCount: 2,
      input: "WhatsApp long final QA check. Use the scripted long final response.",
      matchText: "WHATSAPP-LONG-FINAL-BEGIN",
      settleMs: 4_000,
      target: "dm",
    }),
  },
  {
    id: "whatsapp-approval-exec-deny-native",
    title: "WhatsApp native exec approval prompt denies",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "deny",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_DENY_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-status-reactions",
    standardId: "reaction-observation",
    title: "WhatsApp status reactions are observable",
    timeoutMs: 60_000,
    configOverrides: {
      statusReactions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_STATUS_REACTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { anyEmoji: true },
            timeoutMs: 30_000,
          });
          return `status reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker after normal processing: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-status-reaction-lifecycle",
    title: "WhatsApp status reaction lifecycle updates the triggering message",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      statusReactions: {
        timing: {
          debounceMs: 0,
          stallSoftMs: 60_000,
          stallHardMs: 120_000,
        },
      },
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_STATUS_LIFECYCLE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const reactions = await waitForWhatsAppSutReactionSequenceToTrigger(context, {
            emojis: ["👀", "✅"],
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
          });
          for (const reaction of reactions) {
            context.recordObservedMessage(reaction);
          }
          return `status reaction lifecycle observed ${reactions
            .map((reaction) => reaction.reaction?.emoji ?? "<unknown>")
            .join(" -> ")}`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker after normal processing: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-allowlist-block",
    standardId: "allowlist-block",
    title: "WhatsApp group outside allowlist stays quiet",
    timeoutMs: 8_000,
    configOverrides: {
      blockGroupSender: true,
      groupPolicy: "allowlist",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const quietToken = `WHATSAPP_QA_GROUP_BLOCK_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: false,
        input: `openclawqa blocked group should not reply with ${quietToken}`,
        matchText: quietToken,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-approval-exec-native",
    title: "WhatsApp native exec approval prompt resolves",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-exec-reaction-native",
    title: "WhatsApp native exec approval resolves from reaction",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      decisionMode: "reaction",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_REACTION_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-exec-group-reaction-native",
    title: "WhatsApp group-origin exec approval resolves from reaction",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    requiresGroupJid: true,
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      decisionMode: "reaction",
      kind: "approval",
      target: "group",
      token: `WHATSAPP_QA_GROUP_EXEC_REACTION_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-plugin-native",
    title: "WhatsApp native plugin approval prompt resolves with exec approvals enabled",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
        plugin: true,
      },
    },
    buildRun: () => ({
      approvalKind: "plugin",
      decision: "allow-once",
      kind: "approval",
      token: `WHATSAPP_QA_PLUGIN_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
];

export const WHATSAPP_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: WHATSAPP_QA_SCENARIOS,
});

export function listWhatsAppQaScenarioCatalog() {
  return WHATSAPP_QA_SCENARIOS.map((scenario) => ({ id: scenario.id }));
}

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof WHATSAPP_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function resolveWhatsAppMetadataRedaction(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[QA_REDACT_PUBLIC_METADATA_ENV];
  return raw === undefined ? true : isTruthyOptIn(raw);
}

function normalizePhone(value: string, label: string) {
  const normalized = normalizeE164(value);
  if (!/^\+[1-9]\d{6,14}$/u.test(normalized)) {
    throw new Error(`${label} must be an E.164 phone number.`);
  }
  return normalized;
}

function validateWhatsAppQaRuntimeEnv(
  runtimeEnv: WhatsAppQaRuntimeEnv,
  label: string,
): WhatsAppQaRuntimeEnv {
  const driverPhoneE164 = normalizePhone(runtimeEnv.driverPhoneE164, `${label} driverPhoneE164`);
  const sutPhoneE164 = normalizePhone(runtimeEnv.sutPhoneE164, `${label} sutPhoneE164`);
  if (driverPhoneE164 === sutPhoneE164) {
    throw new Error(`${label} requires two distinct WhatsApp phone numbers.`);
  }
  return {
    ...runtimeEnv,
    driverPhoneE164,
    sutPhoneE164,
  };
}

function resolveWhatsAppQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppQaRuntimeEnv {
  return validateWhatsAppQaRuntimeEnv(
    {
      driverPhoneE164: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164"),
      sutPhoneE164: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164"),
      driverAuthArchiveBase64: resolveEnvValue(
        env,
        "OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64",
      ),
      sutAuthArchiveBase64: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64"),
      groupJid: env.OPENCLAW_QA_WHATSAPP_GROUP_JID?.trim() || undefined,
    },
    "OPENCLAW_QA_WHATSAPP",
  );
}

function parseWhatsAppQaCredentialPayload(payload: unknown): WhatsAppQaRuntimeEnv {
  const parsed = whatsappQaCredentialPayloadSchema.parse(payload);
  return validateWhatsAppQaRuntimeEnv(parsed, "WhatsApp credential payload");
}

function shouldRunWhatsAppScenarioByDefault(
  scenario: WhatsAppQaScenarioDefinition,
  providerMode: QaProviderMode,
) {
  if (scenario.defaultEnabled === false) {
    return false;
  }
  if (scenario.standardId) {
    return true;
  }
  return Boolean(scenario.defaultProviderModes?.includes(providerMode));
}

function findScenarios(
  ids?: string[],
  providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE,
) {
  const scenarios =
    ids && ids.length > 0
      ? WHATSAPP_QA_SCENARIOS
      : WHATSAPP_QA_SCENARIOS.filter((scenario) =>
          shouldRunWhatsAppScenarioByDefault(scenario, providerMode),
        );
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "WhatsApp",
    scenarios,
  });
}

function buildNonMatchingWhatsAppQaAllowFrom(existingAllowFrom: string[]) {
  const existing = new Set(
    existingAllowFrom
      .map((value) => normalizeE164(value))
      .filter((value): value is string => Boolean(value)),
  );
  for (let suffix = 0; suffix <= 9999; suffix += 1) {
    const candidate = `+1555${String(suffix).padStart(7, "0")}`;
    if (!existing.has(candidate)) {
      return [candidate];
    }
  }
  throw new Error("Unable to derive a WhatsApp QA groupAllowFrom entry outside allowFrom.");
}

type WhatsAppQaAgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function buildWhatsAppQaScenarioAgent(agentId: string): WhatsAppQaAgentConfig {
  const identityName =
    agentId === "main"
      ? "Main WhatsApp QA"
      : agentId === "qa-second"
        ? "Second WhatsApp QA"
        : `WhatsApp QA ${agentId}`;
  return {
    id: agentId,
    identity: {
      name: identityName,
    },
  };
}

function appendWhatsAppQaAgents(
  agents: OpenClawConfig["agents"],
  agentIds: readonly string[],
): OpenClawConfig["agents"] {
  if (agentIds.length === 0) {
    return agents;
  }
  const list = [...(agents?.list ?? [])];
  const existingIds = new Set(list.map((agent) => agent.id));
  for (const agentId of agentIds) {
    if (!existingIds.has(agentId)) {
      list.push(buildWhatsAppQaScenarioAgent(agentId));
      existingIds.add(agentId);
    }
  }
  return {
    ...agents,
    list,
  };
}

function buildWhatsAppQaBroadcastConfig(
  baseCfg: OpenClawConfig,
  params: {
    broadcast?: WhatsAppQaConfigOverrides["broadcast"];
    groupJid?: string;
  },
): Pick<OpenClawConfig, "agents" | "broadcast"> {
  if (!params.broadcast) {
    return {};
  }
  const agentIds = uniqueStrings(normalizeStringEntries(params.broadcast.agents));
  return {
    ...(params.groupJid
      ? {
          broadcast: {
            ...baseCfg.broadcast,
            strategy: params.broadcast.strategy ?? baseCfg.broadcast?.strategy ?? "parallel",
            [params.groupJid]: agentIds,
          },
        }
      : {}),
    ...(agentIds.length > 0
      ? {
          agents: appendWhatsAppQaAgents(baseCfg.agents, agentIds),
        }
      : {}),
  };
}

function buildWhatsAppQaMockAuthAgentIds(scenario: WhatsAppQaScenarioDefinition) {
  return uniqueStrings([
    "main",
    "qa",
    ...normalizeStringEntries(scenario.configOverrides?.broadcast?.agents ?? []),
  ]);
}

function buildWhatsAppQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    allowFrom: string[];
    authDir: string;
    dmPolicy: "allowlist" | "disabled" | "open" | "pairing";
    groupJid?: string;
    overrides?: WhatsAppQaConfigOverrides;
    sutAccountId: string;
  },
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "whatsapp"]);
  const approvalOverrides = params.overrides?.approvals;
  const groupPolicy = params.overrides?.groupPolicy ?? "open";
  const groupAllowFrom = params.overrides?.blockGroupSender
    ? buildNonMatchingWhatsAppQaAllowFrom(params.allowFrom)
    : undefined;
  const groupHistoryLimit = params.overrides?.groupHistoryLimit;
  const statusReactionOverride =
    typeof params.overrides?.statusReactions === "object"
      ? params.overrides.statusReactions
      : undefined;
  const statusReactionsEnabled = Boolean(params.overrides?.statusReactions);
  const whatsappHistoryLimit =
    typeof groupHistoryLimit === "number" && groupHistoryLimit > 0
      ? { historyLimit: groupHistoryLimit }
      : {};
  const baseWhatsAppConfig = baseCfg.channels?.whatsapp;
  const baseSutAccountConfig = baseWhatsAppConfig?.accounts?.[params.sutAccountId] ?? {};
  const broadcastConfig = buildWhatsAppQaBroadcastConfig(baseCfg, {
    broadcast: params.overrides?.broadcast,
    groupJid: params.groupJid,
  });
  const audioPreflightConfig = params.overrides?.audioPreflight
    ? {
        tools: {
          ...baseCfg.tools,
          media: {
            ...baseCfg.tools?.media,
            audio: {
              ...baseCfg.tools?.media?.audio,
              enabled: true,
              models: [
                {
                  provider: "openai",
                  model: "gpt-4o-transcribe",
                },
              ],
            },
          },
        },
      }
    : {};
  const approvalForwardingConfig =
    approvalOverrides?.exec || approvalOverrides?.plugin
      ? {
          approvals: {
            ...baseCfg.approvals,
            ...(approvalOverrides.exec
              ? {
                  exec: {
                    ...baseCfg.approvals?.exec,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
            ...(approvalOverrides.plugin
              ? {
                  plugin: {
                    ...baseCfg.approvals?.plugin,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  const actionToolConfig = params.overrides?.actions
    ? {
        tools: {
          ...baseCfg.tools,
          alsoAllow: uniqueStrings([...(baseCfg.tools?.alsoAllow ?? []), "message"]),
        },
      }
    : {};
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...audioPreflightConfig,
    ...broadcastConfig,
    ...actionToolConfig,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        whatsapp: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseWhatsAppConfig,
        enabled: true,
        defaultAccount: params.sutAccountId,
        ...whatsappHistoryLimit,
        ...(statusReactionsEnabled
          ? {
              ackReaction: {
                ...baseCfg.channels?.whatsapp?.ackReaction,
                direct: true,
                emoji: "👀",
              },
            }
          : {}),
        ...(params.overrides?.actions
          ? {
              actions: {
                reactions: true,
                polls: true,
              },
              reactionLevel: "minimal" as const,
            }
          : {}),
        accounts: {
          ...baseWhatsAppConfig?.accounts,
          [params.sutAccountId]: {
            ...baseSutAccountConfig,
            enabled: true,
            authDir: params.authDir,
            dmPolicy: params.dmPolicy,
            allowFrom: params.allowFrom,
            ...(params.overrides?.replyToMode
              ? {
                  replyToMode: params.overrides.replyToMode,
                }
              : {}),
            ...(params.overrides?.inboundDebounceMs !== undefined
              ? {
                  debounceMs: params.overrides.inboundDebounceMs,
                }
              : {}),
            ...(params.groupJid
              ? {
                  groupPolicy,
                  ...(groupAllowFrom
                    ? {
                        groupAllowFrom,
                      }
                    : {}),
                  ...(groupPolicy === "open"
                    ? {
                        groups: {
                          ...baseSutAccountConfig.groups,
                          [params.groupJid]: {
                            ...baseSutAccountConfig.groups?.[params.groupJid],
                            requireMention: true,
                          },
                        },
                      }
                    : {}),
                }
              : {}),
          },
        },
      },
    },
    ...(params.groupJid || statusReactionsEnabled
      ? {
          messages: {
            ...baseCfg.messages,
            ...(params.groupJid
              ? {
                  groupChat: {
                    ...baseCfg.messages?.groupChat,
                    visibleReplies: "automatic",
                    mentionPatterns: [
                      ...new Set([
                        ...(baseCfg.messages?.groupChat?.mentionPatterns ?? []),
                        "\\bopenclawqa\\b",
                      ]),
                    ],
                  },
                }
              : {}),
            ...(statusReactionsEnabled
              ? {
                  ...(statusReactionOverride?.removeAckAfterReply !== undefined
                    ? {
                        removeAckAfterReply: statusReactionOverride.removeAckAfterReply,
                      }
                    : {}),
                  statusReactions: {
                    ...baseCfg.messages?.statusReactions,
                    enabled: true,
                    ...(statusReactionOverride?.timing
                      ? {
                          timing: {
                            ...baseCfg.messages?.statusReactions?.timing,
                            ...statusReactionOverride.timing,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

type WhatsAppChannelStatus = {
  busy?: boolean;
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string;
  lastRunActivityAt?: number | null;
  restartPending?: boolean;
  running?: boolean;
};

function isWhatsAppChannelReady(status: WhatsAppChannelStatus | undefined) {
  return (
    status?.running === true &&
    status.connected === true &&
    status.restartPending !== true &&
    status.busy !== true
  );
}

async function waitForWhatsAppChannelRunning(
  gateway: WhatsAppQaGateway,
  accountId: string,
): Promise<WhatsAppChannelStatus> {
  const startedAt = Date.now();
  let lastStatus: WhatsAppChannelStatus | undefined;
  while (Date.now() - startedAt < WHATSAPP_QA_READY_TIMEOUT_MS) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            busy?: boolean;
            connected?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string;
            lastRunActivityAt?: number | null;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.whatsapp ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            busy: match.busy,
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            lastRunActivityAt: match.lastRunActivityAt,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (isWhatsAppChannelReady(lastStatus)) {
        if (!lastStatus) {
          throw new Error(
            `whatsapp account "${accountId}" status disappeared after readiness check`,
          );
        }
        return lastStatus;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 750);
    });
  }
  throw new Error(
    `whatsapp account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

async function waitForWhatsAppChannelStable(gateway: WhatsAppQaGateway, accountId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WHATSAPP_QA_READY_TIMEOUT_MS) {
    const status = await waitForWhatsAppChannelRunning(gateway, accountId);
    const connectedAt =
      typeof status.lastConnectedAt === "number" && status.lastConnectedAt > 0
        ? status.lastConnectedAt
        : Date.now();
    const connectedForMs = Date.now() - connectedAt;
    if (connectedForMs >= WHATSAPP_QA_READY_STABILITY_MS) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(750, WHATSAPP_QA_READY_STABILITY_MS - connectedForMs));
    });
  }
  throw new Error(
    `whatsapp account "${accountId}" did not remain ready for ${WHATSAPP_QA_READY_STABILITY_MS}ms`,
  );
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: 1024 * 1024,
  });
  return normalizeStringEntries(stdout.split("\n"));
}

function assertSafeArchiveEntries(entries: string[]) {
  if (entries.length === 0) {
    throw new Error("WhatsApp auth archive is empty.");
  }
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
      throw new Error(`WhatsApp auth archive contains unsafe entry "${entry}".`);
    }
  }
}

export async function unpackWhatsAppAuthArchive(params: {
  archiveBase64: string;
  clearSignalSessions?: boolean;
  label: string;
  parentDir: string;
}): Promise<string> {
  const authDir = path.join(params.parentDir, params.label);
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(params.parentDir, `${params.label}.tgz`);
  await fs.writeFile(archivePath, Buffer.from(params.archiveBase64, "base64"), { mode: 0o600 });
  const entries = await listTarEntries(archivePath);
  assertSafeArchiveEntries(entries);
  await execFileAsync("tar", ["-xzf", archivePath, "-C", authDir], { maxBuffer: 1024 * 1024 });
  await fs.rm(archivePath, { force: true });
  if (params.clearSignalSessions === true) {
    await clearWhatsAppAuthSignalSessions(authDir);
  }
  return authDir;
}

async function clearWhatsAppAuthSignalSessions(authDir: string): Promise<string[]> {
  const removed: string[] = [];
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !WHATSAPP_QA_SIGNAL_SESSION_FILE_RE.test(entry.name)) {
      continue;
    }
    await fs.rm(path.join(authDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed.toSorted();
}

function messageMatches(message: WhatsAppObservedMessage, matchText: string | RegExp) {
  return typeof matchText === "string"
    ? message.text.includes(matchText)
    : matchText.test(message.text);
}

type WhatsAppReactionExpectation = { anyEmoji: true } | { emoji: string };

function requireWhatsAppTriggerMessageId(
  context: Pick<WhatsAppQaMessageScenarioContext, "sent">,
): string {
  if (!context.sent.messageId) {
    throw new Error("WhatsApp driver did not return a triggering message id.");
  }
  return context.sent.messageId;
}

function matchesWhatsAppSutReactionToTrigger(
  message: WhatsAppQaDriverObservedMessage,
  context: Pick<
    WhatsAppQaMessageScenarioContext,
    "sent" | "sutPhoneE164" | "target" | "targetKind"
  >,
  expectation: WhatsAppReactionExpectation,
) {
  const observedReaction = message.reaction;
  const fromExpectedSut = isWhatsAppScenarioSutMessage(message, {
    observedAfter: new Date(0),
    sutPhoneE164: context.sutPhoneE164,
    target: context.target,
    targetKind: context.targetKind,
  });
  if (
    typeof context.sent.messageId !== "string" ||
    message.kind !== "reaction" ||
    !fromExpectedSut ||
    !observedReaction ||
    observedReaction.messageId !== context.sent.messageId
  ) {
    return false;
  }
  if ("emoji" in expectation) {
    return observedReaction.emoji === expectation.emoji;
  }
  return Boolean(observedReaction.emoji);
}

async function waitForWhatsAppSutReactionToTrigger(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    expectation: WhatsAppReactionExpectation;
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  requireWhatsAppTriggerMessageId(context);
  return await waitForScenarioObservedMessage(context, {
    observedAfter: params.observedAfter ?? context.requestStartedAt,
    timeoutMs: params.timeoutMs,
    match: (message) => matchesWhatsAppSutReactionToTrigger(message, context, params.expectation),
  });
}

async function waitForWhatsAppSutReactionSequenceToTrigger(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    emojis: readonly string[];
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  requireWhatsAppTriggerMessageId(context);
  const observedAfter = params.observedAfter ?? context.requestStartedAt;
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  const matched: WhatsAppQaDriverObservedMessage[] = [];
  let lastMatchedObservedAtMs = observedAfter.getTime();
  let lastMatchedObservedIndex = -1;

  const scan = () => {
    const messages = context.driver
      .getObservedMessages()
      .map((message, index) => ({ index, message }))
      .toSorted((left, right) => {
        const timeDelta =
          new Date(left.message.observedAt).getTime() -
          new Date(right.message.observedAt).getTime();
        return timeDelta === 0 ? left.index - right.index : timeDelta;
      });
    for (const { index, message } of messages) {
      if (matched.length >= params.emojis.length) {
        return true;
      }
      const observedAtMs = new Date(message.observedAt).getTime();
      if (
        observedAtMs < lastMatchedObservedAtMs ||
        (observedAtMs === lastMatchedObservedAtMs && index <= lastMatchedObservedIndex)
      ) {
        continue;
      }
      const expectedEmoji = params.emojis[matched.length];
      if (!expectedEmoji) {
        return false;
      }
      if (matchesWhatsAppSutReactionToTrigger(message, context, { emoji: expectedEmoji })) {
        matched.push(message);
        lastMatchedObservedAtMs = observedAtMs;
        lastMatchedObservedIndex = index;
      }
    }
    return matched.length >= params.emojis.length;
  };

  while (!scan()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for WhatsApp status reaction sequence ${params.emojis.join(" -> ")}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return matched;
}

function buildWhatsAppQaIdempotencyKey(scenarioId: WhatsAppQaScenarioId, label: string) {
  return `${scenarioId}:${label}:${randomUUID()}`;
}

type WhatsAppQaGatewaySendParams = {
  asVoice?: boolean;
  forceDocument?: boolean;
  label: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  message?: string;
  replyToId?: string;
};

async function writeWhatsAppQaWorkspaceFixture(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    buffer: Buffer;
    fileName: string;
  },
) {
  const fixtureDir = path.join(context.gatewayWorkspaceDir, ".openclaw", "qa-whatsapp-media");
  await fs.mkdir(fixtureDir, { recursive: true });
  const filePath = path.join(fixtureDir, params.fileName);
  await fs.writeFile(filePath, params.buffer);
  return filePath;
}

async function callWhatsAppGatewaySend(
  context: WhatsAppQaGatewayCallContext,
  params: WhatsAppQaGatewaySendParams,
) {
  return await context.gateway.call("send", buildWhatsAppGatewaySendRequest(context, params), {
    timeoutMs: 60_000,
  });
}

function buildWhatsAppGatewaySendRequest(
  context: WhatsAppQaGatewayCallContext,
  params: WhatsAppQaGatewaySendParams,
) {
  return {
    accountId: context.sutAccountId,
    agentId: "main",
    channel: "whatsapp",
    idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
    to: context.gatewayTarget,
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaUrls ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.asVoice !== undefined ? { asVoice: params.asVoice } : {}),
    ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  };
}

async function callWhatsAppGatewaySendConcurrently(
  context: WhatsAppQaMessageScenarioContext,
  sends: WhatsAppQaGatewaySendParams[],
) {
  // Each QA RPC client serializes its own requests. Separate clients preserve
  // real Gateway overlap so this probe reaches the shared WhatsApp socket concurrently.
  const connection = resolveWhatsAppGatewayRpcConnection(context.gateway);
  const clients = await Promise.all(
    sends.map(async (send) => ({
      send,
      client: await startQaGatewayRpcClient({
        logs: connection.logs,
        token: connection.token,
        wsUrl: connection.wsUrl,
      }),
    })),
  );
  try {
    await Promise.all(
      clients.map(({ client, send }) =>
        client.request("send", buildWhatsAppGatewaySendRequest(context, send), {
          timeoutMs: 60_000,
        }),
      ),
    );
  } finally {
    await Promise.all(clients.map(({ client }) => client.stop()));
  }
}

function resolveWhatsAppGatewayRpcConnection(gateway: WhatsAppQaGatewayRuntime) {
  if (!gateway.logs || !gateway.token || !gateway.wsUrl) {
    throw new Error("WhatsApp concurrent Gateway probe requires a live RPC connection.");
  }
  return {
    logs: gateway.logs,
    token: gateway.token,
    wsUrl: gateway.wsUrl,
  };
}

async function callWhatsAppGatewayPoll(
  context: WhatsAppQaGatewayCallContext,
  params: {
    label: string;
    maxSelections?: number;
    options: string[];
    question: string;
  },
) {
  return await context.gateway.call(
    "poll",
    {
      accountId: context.sutAccountId,
      channel: "whatsapp",
      idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
      maxSelections: params.maxSelections,
      options: params.options,
      question: params.question,
      to: context.gatewayTarget,
    },
    { timeoutMs: 60_000 },
  );
}

async function callWhatsAppGatewayMessageAction(
  context: WhatsAppQaGatewayCallContext,
  params: {
    action: "react" | "upload-file";
    label: string;
    params: Record<string, unknown>;
  },
) {
  return await context.gateway.call(
    "message.action",
    {
      accountId: context.sutAccountId,
      action: params.action,
      channel: "whatsapp",
      idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
      params: {
        ...params.params,
        to: context.gatewayTarget,
      },
    },
    { timeoutMs: 60_000 },
  );
}

async function waitForScenarioObservedMessage(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    expectedSender?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    observedAfter?: Date;
    timeoutMs?: number;
  },
) {
  let message: WhatsAppQaDriverObservedMessage;
  try {
    message = await context.driver.waitForMessage({
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs ?? 45_000,
      match: (candidate) =>
        (params.expectedSender?.(candidate) ??
          isWhatsAppScenarioSutMessage(candidate, {
            observedAfter: params.observedAfter ?? new Date(0),
            sutPhoneE164: context.sutPhoneE164,
            target: context.target,
            targetKind: context.targetKind,
          })) &&
        params.match(candidate),
    });
  } catch (error) {
    if (/\btimed out waiting for WhatsApp QA driver message\b/iu.test(formatErrorMessage(error))) {
      throw new Error(
        `${formatErrorMessage(error)}; ${formatWhatsAppScenarioWaitDiagnostics(context, {
          diagnosticChecks: params.diagnosticChecks,
          observedAfter: params.observedAfter,
        })}`,
        { cause: error },
      );
    }
    throw error;
  }
  context.recordObservedMessage(message);
  return message;
}

function formatDiagnosticId(value: string | undefined | null) {
  return value ? `present(length=${value.length})` : "missing";
}

function formatWhatsAppMessageShape(message: WhatsAppQaDriverObservedMessage, index: number) {
  return [
    `#${index + 1}`,
    `observedAt=${message.observedAt}`,
    `fromPhone=${message.fromPhoneE164 ? "present" : "missing"}`,
    `kind=${message.kind}`,
    `textLength=${message.text.length}`,
    `messageId=${formatDiagnosticId(message.messageId)}`,
    `quoted=${message.quoted ? "present" : "missing"}`,
    `quotedMessageId=${formatDiagnosticId(message.quoted?.messageId)}`,
  ].join(" ");
}

function formatWhatsAppScenarioWaitDiagnostics(
  context: WhatsAppQaObservedMessagesContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    observedAfter?: Date;
  },
) {
  const lowerBoundMs = params.observedAfter?.getTime();
  const messages = context.driver.getObservedMessages().filter((message) => {
    if (lowerBoundMs === undefined) {
      return true;
    }
    return new Date(message.observedAt).getTime() >= lowerBoundMs;
  });
  if (messages.length === 0) {
    return "observed 0 WhatsApp driver message(s) after wait lower bound";
  }
  const formatted = messages.slice(-5).map((message, index) => {
    const checks = (params.diagnosticChecks ?? []).map((check) => {
      try {
        const matched = check.match(message);
        return `${check.label}=${matched ? "yes" : "no"}`;
      } catch {
        return `${check.label}=no`;
      }
    });
    return [
      formatWhatsAppMessageShape(message, index),
      `fromExpectedSut=${
        isWhatsAppScenarioSutMessage(message, {
          observedAfter: params.observedAfter ?? new Date(0),
          sutPhoneE164: context.sutPhoneE164,
          target: context.target,
          targetKind: context.targetKind,
        })
          ? "yes"
          : "no"
      }`,
      ...checks,
    ].join(" ");
  });
  return `observed ${messages.length} WhatsApp driver message(s) after wait lower bound: ${formatted.join("; ")}`;
}

function hasWhatsAppBatchExpectations(run: WhatsAppQaMessageScenarioRun) {
  return (
    run.expectedSutMessageCount !== undefined ||
    run.expectedSutMessageCountRange !== undefined ||
    (run.expectedJoinedSutTextIncludes?.length ?? 0) > 0
  );
}

function isWhatsAppScenarioSutMessage(
  message: WhatsAppQaDriverObservedMessage,
  params: {
    observedAfter: Date;
    sutPhoneE164: string;
    target: string;
    targetKind: "dm" | "group";
  },
) {
  if (new Date(message.observedAt).getTime() < params.observedAfter.getTime()) {
    return false;
  }
  if (params.targetKind === "group") {
    return message.fromJid === params.target && message.fromPhoneE164 === params.sutPhoneE164;
  }
  return message.fromPhoneE164 === params.sutPhoneE164;
}

function assertWhatsAppMessageFromSutPhone(
  message: WhatsAppQaDriverObservedMessage,
  context: Pick<WhatsAppQaMessageScenarioContext, "sutPhoneE164">,
) {
  if (message.fromPhoneE164 === context.sutPhoneE164) {
    return;
  }
  throw new Error(
    `expected WhatsApp group reply from configured SUT phone; ${formatWhatsAppMessageShape(message, 0)}`,
  );
}

function assertWhatsAppMessagesFromSutPhone(
  messages: readonly WhatsAppQaDriverObservedMessage[],
  context: Pick<WhatsAppQaMessageScenarioContext, "sutPhoneE164">,
) {
  for (const message of messages) {
    assertWhatsAppMessageFromSutPhone(message, context);
  }
}

async function assertWhatsAppScenarioMessageBatch(params: {
  alreadyRecordedMessageIds: Set<string>;
  context: WhatsAppQaMessageScenarioContext;
  observedAfter: Date;
  run: WhatsAppQaMessageScenarioRun;
}) {
  if (!hasWhatsAppBatchExpectations(params.run)) {
    return undefined;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, params.run.settleMs ?? 4_000);
  });
  const messages = params.context.driver.getObservedMessages().filter((message) =>
    isWhatsAppScenarioSutMessage(message, {
      observedAfter: params.observedAfter,
      sutPhoneE164: params.context.sutPhoneE164,
      target: params.context.target,
      targetKind: params.run.target,
    }),
  );
  const uniqueMessages = dedupeWhatsAppMessagesById(messages);
  if (
    params.run.expectedSutMessageCount !== undefined &&
    uniqueMessages.length !== params.run.expectedSutMessageCount
  ) {
    throw new Error(
      `expected ${params.run.expectedSutMessageCount} SUT message(s), observed ${
        uniqueMessages.length
      }: ${formatWhatsAppBatchMessageDiagnostics(uniqueMessages)}`,
    );
  }
  if (params.run.expectedSutMessageCountRange !== undefined) {
    const [min, max] = params.run.expectedSutMessageCountRange;
    if (uniqueMessages.length < min || uniqueMessages.length > max) {
      throw new Error(
        `expected ${min}-${max} SUT message(s), observed ${
          uniqueMessages.length
        }: ${formatWhatsAppBatchMessageDiagnostics(uniqueMessages)}`,
      );
    }
  }
  const joinedText = uniqueMessages.map((message) => message.text).join("\n");
  for (const expected of params.run.expectedJoinedSutTextIncludes ?? []) {
    if (!joinedText.includes(expected)) {
      throw new Error(`expected joined WhatsApp SUT text to include ${expected}`);
    }
  }
  for (const message of uniqueMessages) {
    if (!message.messageId || params.alreadyRecordedMessageIds.has(message.messageId)) {
      continue;
    }
    params.context.recordObservedMessage(message);
    params.alreadyRecordedMessageIds.add(message.messageId);
  }
  return `observed ${uniqueMessages.length} SUT message(s) after settle`;
}

function formatWhatsAppBatchMessageDiagnostics(messages: WhatsAppQaDriverObservedMessage[]) {
  if (messages.length === 0) {
    return "no matching SUT message shapes observed";
  }
  return messages.slice(-5).map(formatWhatsAppMessageShape).join("; ");
}

function dedupeWhatsAppMessagesById(messages: WhatsAppQaDriverObservedMessage[]) {
  const seen = new Set<string>();
  const unique: WhatsAppQaDriverObservedMessage[] = [];
  for (const message of messages) {
    const messageId = message.messageId?.trim();
    if (messageId) {
      if (seen.has(messageId)) {
        continue;
      }
      seen.add(messageId);
    }
    unique.push(message);
  }
  return unique;
}

function buildWhatsAppQuotedMessageKeyFromObservedMessage(
  message: WhatsAppQaDriverObservedMessage,
  params: { remoteJid: string },
): WhatsAppQaDriverQuotedMessageKey {
  if (!message.messageId) {
    throw new Error("WhatsApp observed message did not include a message id for quoting.");
  }
  return {
    fromMe: false,
    id: message.messageId,
    messageText: message.text,
    ...(message.participantJid ? { participant: message.participantJid } : {}),
    remoteJid: params.remoteJid,
  };
}

type WhatsAppQaNoReplyTarget =
  | {
      target: "dm";
    }
  | {
      groupJid: string;
      target: "group";
    };

function resolveWhatsAppQaNoReplyTarget(params: {
  groupJid?: string;
  target: "dm" | "group";
}): WhatsAppQaNoReplyTarget {
  if (params.target === "dm") {
    return { target: "dm" };
  }
  if (!params.groupJid) {
    throw new Error("WhatsApp group no-reply assertion requires groupJid.");
  }
  return {
    groupJid: params.groupJid,
    target: "group",
  };
}

async function waitForNoWhatsAppReply(
  params: {
    allowQuietWindowMessage?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    driver: Pick<WhatsAppQaDriverSession, "getObservedMessages">;
    observedAfter: Date;
    sutPhoneE164: string;
    windowMs: number;
  } & WhatsAppQaNoReplyTarget,
) {
  await new Promise((resolve) => {
    setTimeout(resolve, params.windowMs);
  });
  const noReplyTarget =
    params.target === "group"
      ? ({
          groupJid: params.groupJid,
          target: "group",
        } satisfies WhatsAppQaNoReplyTarget)
      : ({
          target: "dm",
        } satisfies WhatsAppQaNoReplyTarget);
  const unexpectedReply = findUnexpectedWhatsAppNoReplyMessage({
    allowQuietWindowMessage: params.allowQuietWindowMessage,
    messages: params.driver.getObservedMessages(),
    observedAfter: params.observedAfter,
    sutPhoneE164: params.sutPhoneE164,
    ...noReplyTarget,
  });
  if (unexpectedReply) {
    throw new Error("unexpected WhatsApp reply observed in quiet scenario");
  }
}

async function waitForDistinctWhatsAppSutMessages(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    initialMessages?: WhatsAppQaDriverObservedMessage[];
    matchers: Array<(message: WhatsAppQaDriverObservedMessage) => boolean>;
    observedAfter: Date;
    timeoutMs?: number;
  },
) {
  const matched = new Map<number, WhatsAppQaDriverObservedMessage>();
  const usedMessageKeys = new Set<string>();
  const messageKey = (message: WhatsAppQaDriverObservedMessage) =>
    message.messageId ?? `${message.observedAt}:${message.text}`;
  const consider = (message: WhatsAppQaDriverObservedMessage) => {
    if (
      !isWhatsAppScenarioSutMessage(message, {
        observedAfter: params.observedAfter,
        sutPhoneE164: context.sutPhoneE164,
        target: context.target,
        targetKind: "group",
      })
    ) {
      return false;
    }
    const key = messageKey(message);
    if (usedMessageKeys.has(key)) {
      return false;
    }
    for (const [index, matcher] of params.matchers.entries()) {
      if (!matched.has(index) && matcher(message)) {
        matched.set(index, message);
        usedMessageKeys.add(key);
        return true;
      }
    }
    return false;
  };

  for (const message of [
    ...(params.initialMessages ?? []),
    ...context.driver.getObservedMessages(),
  ]) {
    consider(message);
  }

  while (matched.size < params.matchers.length) {
    const next = await waitForWhatsAppScenarioSutMessage(context, {
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs,
      targetKind: "group",
      match: (message) => {
        const key = messageKey(message);
        return (
          !usedMessageKeys.has(key) &&
          params.matchers.some((matcher, index) => !matched.has(index) && matcher(message))
        );
      },
    });
    consider(next);
  }

  return [...matched.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, message]) => message);
}

async function waitForWhatsAppScenarioSutMessage(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    diagnosticChecks?: Array<{
      label: string;
      match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    }>;
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    observedAfter: Date;
    targetKind: "dm" | "group";
    timeoutMs?: number;
  },
) {
  return await waitForScenarioObservedMessage(context, {
    diagnosticChecks: params.diagnosticChecks,
    observedAfter: params.observedAfter,
    timeoutMs: params.timeoutMs,
    expectedSender: (message) =>
      isWhatsAppScenarioSutMessage(message, {
        observedAfter: params.observedAfter,
        sutPhoneE164: context.sutPhoneE164,
        target: context.target,
        targetKind: params.targetKind,
      }),
    match: params.match,
  });
}

function findUnexpectedWhatsAppNoReplyMessage(
  params: {
    allowQuietWindowMessage?: (message: WhatsAppQaDriverObservedMessage) => boolean;
    messages: WhatsAppQaDriverObservedMessage[];
    observedAfter: Date;
    sutPhoneE164: string;
  } & WhatsAppQaNoReplyTarget,
): WhatsAppQaDriverObservedMessage | undefined {
  const observedAfterMs = params.observedAfter.getTime();
  return params.messages.find((message) => {
    if (new Date(message.observedAt).getTime() <= observedAfterMs) {
      return false;
    }
    const fromExpectedSut = isWhatsAppScenarioSutMessage(message, {
      observedAfter: params.observedAfter,
      sutPhoneE164: params.sutPhoneE164,
      target: params.target === "group" ? params.groupJid : "",
      targetKind: params.target,
    });
    const missingGroupSender =
      params.target === "group" && message.fromJid === params.groupJid && !message.fromPhoneE164;
    if (!fromExpectedSut && !missingGroupSender) {
      return false;
    }
    return !(params.allowQuietWindowMessage?.(message) ?? false);
  });
}

function isTransientWhatsAppQaDriverError(error: unknown) {
  const message = formatErrorMessage(error);
  return (
    /\bConnection Closed\b/iu.test(message) ||
    /\bconflict\b/iu.test(message) ||
    /\bpending notifications\b/iu.test(message) ||
    /\bsession conflict\b/iu.test(message)
  );
}

async function restartWhatsAppQaDriverSession(params: {
  authDir: string;
  current: WhatsAppQaDriverSession;
}) {
  await params.current.close().catch(() => {});
  return await startWhatsAppQaDriverSessionWithRetry({ authDir: params.authDir });
}

async function startWhatsAppQaDriverSessionWithRetry(params: { authDir: string }) {
  for (const attempt of Array.from(
    { length: WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS },
    (_, index) => index + 1,
  )) {
    try {
      return await startWhatsAppQaDriverSession({
        authDir: params.authDir,
        waitForPendingNotifications: true,
      });
    } catch (error) {
      if (
        attempt >= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS ||
        !isTransientWhatsAppQaDriverError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS);
      });
    }
  }
  throw new Error("unreachable WhatsApp QA driver retry loop exit");
}

async function requestWhatsAppApproval(params: {
  approvalId: string;
  gateway: WhatsAppQaGateway;
  turnSourceTo: string;
  run: WhatsAppQaApprovalScenarioRun;
  sutAccountId: string;
}) {
  const commonParams = {
    timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS,
    turnSourceAccountId: params.sutAccountId,
    turnSourceChannel: "whatsapp",
    turnSourceTo: params.turnSourceTo,
    twoPhase: true,
  };
  if (params.run.approvalKind === "exec") {
    const result = await params.gateway.call(
      "exec.approval.request",
      {
        ...commonParams,
        ask: "always",
        command: `printf '%s\\n' '${params.run.token}'`,
        host: "gateway",
        id: params.approvalId,
        security: "full",
      },
      {
        expectFinal: false,
        timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
      },
    );
    const acceptedId = readAcceptedApprovalRequestId(result);
    if (acceptedId !== params.approvalId) {
      throw new Error(
        `accepted exec approval id was ${formatApprovalResultValue(
          acceptedId,
        )} instead of ${params.approvalId}`,
      );
    }
    return acceptedId;
  }
  const result = await params.gateway.call(
    "plugin.approval.request",
    {
      ...commonParams,
      agentId: "qa",
      description: `WhatsApp plugin approval QA request ${params.run.token}`,
      pluginId: "qa-whatsapp-plugin",
      severity: "warning",
      title: `WhatsApp plugin approval QA ${params.run.token}`,
      toolName: "whatsapp_qa_tool",
    },
    {
      expectFinal: false,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  return readAcceptedApprovalRequestId(result);
}

async function waitForApprovalDecision(params: {
  approvalId: string;
  gateway: WhatsAppQaGateway;
  kind: WhatsAppQaApprovalKind;
}) {
  const method =
    params.kind === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
  return await params.gateway.call(
    method,
    { id: params.approvalId },
    {
      expectFinal: true,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function resolveApprovalDecision(params: {
  approvalId: string;
  decision: WhatsAppQaApprovalDecision;
  gateway: WhatsAppQaGateway;
  kind: WhatsAppQaApprovalKind;
}) {
  const method = params.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
  return await params.gateway.call(
    method,
    { decision: params.decision, id: params.approvalId },
    {
      expectFinal: false,
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

function matchesWhatsAppApprovalPendingText(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  text: string;
  token: string;
}) {
  const heading =
    params.approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
  return (
    params.text.includes(heading) &&
    params.text.includes(params.approvalId) &&
    params.text.includes(params.token) &&
    params.text.includes("React with:") &&
    params.text.includes("👍")
  );
}

function matchesWhatsAppApprovalResolvedText(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  text: string;
}) {
  const decision = params.decision ?? "allow-once";
  const decisionText =
    params.approvalKind === "exec"
      ? decision
      : decision === "allow-once"
        ? "allowed once"
        : "denied";
  const heading =
    params.approvalKind === "exec"
      ? `Exec approval ${decisionText}`
      : `Plugin approval ${decisionText}`;
  return params.text.includes(params.approvalId) && params.text.includes(heading);
}

function formatWhatsAppApprovalWaitDiagnostics(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  driver: WhatsAppQaDriverSession;
  observedAfter?: Date;
  state: "pending" | "resolved";
  sutPhoneE164: string;
  token: string;
}) {
  const lowerBoundMs = params.observedAfter?.getTime();
  const messages = params.driver.getObservedMessages().filter((message) => {
    if (lowerBoundMs === undefined) {
      return true;
    }
    return new Date(message.observedAt).getTime() >= lowerBoundMs;
  });
  if (messages.length === 0) {
    return `observed 0 WhatsApp driver message(s) after ${params.state} approval wait lower bound`;
  }
  const formatted = messages.slice(-5).map((message, index) => {
    const fromExpectedSender =
      !message.fromPhoneE164 || message.fromPhoneE164 === params.sutPhoneE164;
    const approvalTextMatches =
      params.state === "pending"
        ? matchesWhatsAppApprovalPendingText({
            approvalId: params.approvalId,
            approvalKind: params.approvalKind,
            text: message.text,
            token: params.token,
          })
        : matchesWhatsAppApprovalResolvedText({
            approvalId: params.approvalId,
            approvalKind: params.approvalKind,
            decision: params.decision,
            text: message.text,
          });
    return [
      `#${index + 1}`,
      `observedAt=${message.observedAt}`,
      `fromExpectedSut=${fromExpectedSender ? "yes" : "no"}`,
      `fromPhone=${message.fromPhoneE164 ? "present" : "missing"}`,
      `kind=${message.kind}`,
      `textLength=${message.text.length}`,
      `approvalText=${approvalTextMatches ? "yes" : "no"}`,
      `messageId=${formatDiagnosticId(message.messageId)}`,
    ].join(" ");
  });
  return `observed ${messages.length} WhatsApp driver message(s) after ${params.state} approval wait lower bound: ${formatted.join("; ")}`;
}

async function waitForWhatsAppApprovalMessage(params: {
  approvalId: string;
  approvalKind: WhatsAppQaApprovalKind;
  decision?: WhatsAppQaApprovalDecision;
  driver: WhatsAppQaDriverSession;
  observedAfter?: Date;
  observedMessages: WhatsAppObservedMessage[];
  scenario: WhatsAppQaScenarioDefinition;
  state: "pending" | "resolved";
  sutPhoneE164: string;
  timeoutMs: number;
  token: string;
}) {
  let reply: WhatsAppQaDriverObservedMessage;
  try {
    reply = await params.driver.waitForMessage({
      observedAfter: params.observedAfter,
      timeoutMs: params.timeoutMs,
      match: (message) => {
        const fromExpectedSender =
          !message.fromPhoneE164 || message.fromPhoneE164 === params.sutPhoneE164;
        return (
          fromExpectedSender &&
          (params.state === "pending"
            ? matchesWhatsAppApprovalPendingText({
                approvalId: params.approvalId,
                approvalKind: params.approvalKind,
                text: message.text,
                token: params.token,
              })
            : matchesWhatsAppApprovalResolvedText({
                approvalId: params.approvalId,
                approvalKind: params.approvalKind,
                decision: params.decision,
                text: message.text,
              }))
        );
      },
    });
  } catch (error) {
    if (/\btimed out waiting for WhatsApp QA driver message\b/iu.test(formatErrorMessage(error))) {
      throw new Error(
        `${formatErrorMessage(error)}; ${formatWhatsAppApprovalWaitDiagnostics(params)}`,
        { cause: error },
      );
    }
    throw error;
  }
  const observed: WhatsAppObservedMessage = {
    ...reply,
    approvalState: params.state,
    matchedScenario: true,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
  };
  params.observedMessages.push(observed);
  return observed;
}

async function runWhatsAppApprovalScenario(params: {
  driver: WhatsAppQaDriverSession;
  gateway: WhatsAppQaGateway;
  observedMessages: WhatsAppObservedMessage[];
  run: WhatsAppQaApprovalScenarioRun;
  scenario: WhatsAppQaScenarioDefinition;
  sutAccountId: string;
  sutPhoneE164: string;
  turnSourceTo: string;
}) {
  const requestStartedAt = new Date();
  const requestedApprovalId =
    params.run.approvalKind === "exec"
      ? `whatsapp-qa-exec-${randomUUID()}`
      : `whatsapp-qa-plugin-${randomUUID()}`;
  const approvalId = await requestWhatsAppApproval({
    approvalId: requestedApprovalId,
    gateway: params.gateway,
    turnSourceTo: params.turnSourceTo,
    run: params.run,
    sutAccountId: params.sutAccountId,
  });
  const pending = await waitForWhatsAppApprovalMessage({
    approvalId,
    approvalKind: params.run.approvalKind,
    decision: params.run.decision,
    driver: params.driver,
    observedAfter: requestStartedAt,
    observedMessages: params.observedMessages,
    scenario: params.scenario,
    state: "pending",
    sutPhoneE164: params.sutPhoneE164,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  const resolvedPromise = waitForWhatsAppApprovalMessage({
    approvalId,
    approvalKind: params.run.approvalKind,
    decision: params.run.decision,
    driver: params.driver,
    observedAfter: requestStartedAt,
    observedMessages: params.observedMessages,
    scenario: params.scenario,
    state: "resolved",
    sutPhoneE164: params.sutPhoneE164,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  try {
    if (params.run.decisionMode === "reaction") {
      if (!pending.fromJid || !pending.messageId) {
        throw new Error("WhatsApp approval prompt did not expose message coordinates.");
      }
      await params.driver.sendReaction(pending.fromJid, pending.messageId, "👍", {
        fromMe: false,
        participant: pending.participantJid,
      });
    } else {
      await resolveApprovalDecision({
        approvalId,
        decision: params.run.decision,
        gateway: params.gateway,
        kind: params.run.approvalKind,
      });
    }
    assertApprovalDecisionResult({
      decision: params.run.decision,
      result: await waitForApprovalDecision({
        approvalId,
        gateway: params.gateway,
        kind: params.run.approvalKind,
      }),
    });
  } catch (error) {
    resolvedPromise.catch(() => {});
    throw error;
  }
  const resolved = await resolvedPromise;
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    approvalId,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}

async function runWhatsAppScenario(params: {
  driver: WhatsAppQaDriverSession;
  driverPhoneE164: string;
  gatewayDebugDirPath: string;
  observedMessages: WhatsAppObservedMessage[];
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  repoRoot: string;
  scenario: WhatsAppQaScenarioDefinition;
  sutAccountId: string;
  sutAuthDir: string;
  sutPhoneE164: string;
  groupJid?: string;
  onGatewayDebugPreserveFailure?: (error: unknown) => void;
  onGatewayDebugPreserved?: () => void;
}): Promise<WhatsAppQaScenarioResult> {
  const scenarioRun = params.scenario.buildRun();
  const resolvedTarget = resolveWhatsAppQaScenarioTarget({
    groupJid: params.groupJid,
    scenarioId: params.scenario.id,
    target: scenarioRun.kind === "approval" ? (scenarioRun.target ?? "dm") : scenarioRun.target,
  });
  const groupJidForScenario =
    resolvedTarget.target === "group" ? resolvedTarget.groupJid : undefined;
  const targets =
    scenarioRun.kind !== "approval"
      ? resolveWhatsAppQaMessageTargets({
          driverPhoneE164: params.driverPhoneE164,
          groupJid: params.groupJid,
          scenarioTarget: scenarioRun.target,
          sutPhoneE164: params.sutPhoneE164,
        })
      : undefined;
  const target = targets?.driverTarget ?? params.sutPhoneE164;
  const approvalTurnSourceTo =
    scenarioRun.kind === "approval" && resolvedTarget.target === "group"
      ? resolvedTarget.groupJid
      : params.driverPhoneE164;
  const allowFrom =
    scenarioRun.kind === "approval"
      ? [params.driverPhoneE164]
      : scenarioRun.configMode === "open"
        ? ["*"]
        : scenarioRun.configMode === "pairing"
          ? ["+15550000000"]
          : [params.driverPhoneE164];
  const dmPolicy =
    scenarioRun.kind === "approval"
      ? "allowlist"
      : scenarioRun.configMode === "open" || scenarioRun.configMode === "disabled"
        ? scenarioRun.configMode
        : scenarioRun.configMode === "allowlist"
          ? "allowlist"
          : "pairing";
  const gatewayHarness = await startQaLiveLaneGateway({
    repoRoot: params.repoRoot,
    transport: {
      requiredPluginIds: params.scenario.requiredPluginIds ?? [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1:0",
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(params.repoRoot, "dist", "index.js")],
      argsSuffix: ["--verbose"],
    },
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    controlUiEnabled: false,
    mockAuthAgentIds: buildWhatsAppQaMockAuthAgentIds(params.scenario),
    mutateConfig: (cfg) =>
      buildWhatsAppQaConfig(cfg, {
        allowFrom,
        authDir: params.sutAuthDir,
        dmPolicy,
        groupJid: groupJidForScenario,
        overrides: params.scenario.configOverrides,
        sutAccountId: params.sutAccountId,
      }),
  });
  let preservedGatewayDebug = false;
  try {
    await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
    if (scenarioRun.kind === "approval") {
      const approval = await runWhatsAppApprovalScenario({
        driver: params.driver,
        gateway: gatewayHarness.gateway,
        observedMessages: params.observedMessages,
        run: scenarioRun,
        scenario: params.scenario,
        sutAccountId: params.sutAccountId,
        sutPhoneE164: params.sutPhoneE164,
        turnSourceTo: approvalTurnSourceTo,
      });
      return {
        ...buildWhatsAppQaScenarioResultBase(params.scenario),
        status: "pass" as const,
        details: `${scenarioRun.approvalKind} approval ${approval.approvalId} resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
        rttMs: approval.rttMs,
        requestStartedAt: approval.requestStartedAt.toISOString(),
        responseObservedAt: approval.responseObservedAt.toISOString(),
        rttMeasurement: {
          finalMatchedReplyRttMs: approval.rttMs,
          requestStartedAt: approval.requestStartedAt.toISOString(),
          responseObservedAt: approval.responseObservedAt.toISOString(),
          source: "approval-request-to-resolution" as const,
        },
      };
    }
    if (scenarioRun.quietInput !== undefined) {
      const quietStartedAt = new Date();
      const quietSendMode = scenarioRun.quietSendMode ?? scenarioRun.sendMode;
      if (quietSendMode?.kind === "media") {
        await params.driver.sendMedia(
          target,
          scenarioRun.quietInput,
          quietSendMode.mediaBuffer,
          quietSendMode.mediaType,
          {
            fileName: quietSendMode.fileName,
          },
        );
      } else {
        await params.driver.sendText(target, scenarioRun.quietInput);
      }
      const quietMatchText = scenarioRun.quietMatchText;
      await waitForNoWhatsAppReply({
        ...(quietMatchText
          ? {
              allowQuietWindowMessage: (message: WhatsAppQaDriverObservedMessage) =>
                !messageMatches(message as WhatsAppObservedMessage, quietMatchText),
            }
          : {}),
        driver: params.driver,
        observedAfter: quietStartedAt,
        sutPhoneE164: params.sutPhoneE164,
        windowMs: scenarioRun.quietWindowMs ?? 5_000,
        ...resolveWhatsAppQaNoReplyTarget({
          groupJid: params.groupJid,
          target: scenarioRun.target,
        }),
      });
      await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
    }
    const requestStartedAt = new Date();
    const sent =
      scenarioRun.sendMode?.kind === "media"
        ? await params.driver.sendMedia(
            target,
            scenarioRun.input,
            scenarioRun.sendMode.mediaBuffer,
            scenarioRun.sendMode.mediaType,
            {
              fileName: scenarioRun.sendMode.fileName,
            },
          )
        : await params.driver.sendText(target, scenarioRun.input);
    const scenarioContext: WhatsAppQaMessageScenarioContext = {
      driver: params.driver,
      driverPhoneE164: params.driverPhoneE164,
      gateway: gatewayHarness.gateway,
      gatewayTarget: targets?.gatewayTarget ?? params.driverPhoneE164,
      gatewayWorkspaceDir: gatewayHarness.gateway.workspaceDir,
      recordObservedMessage: (message) => {
        params.observedMessages.push({
          ...message,
          matchedScenario: true,
          scenarioId: params.scenario.id,
          scenarioTitle: params.scenario.title,
        });
      },
      requestStartedAt,
      scenarioId: params.scenario.id,
      scenarioTitle: params.scenario.title,
      sent,
      sutAccountId: params.sutAccountId,
      sutPhoneE164: params.sutPhoneE164,
      target,
      targetKind: scenarioRun.target,
      waitForReady: async () => {
        await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
      },
    };
    const afterSendDetails = await scenarioRun.afterSend?.(scenarioContext);
    if (!scenarioRun.expectReply) {
      await waitForNoWhatsAppReply({
        allowQuietWindowMessage: (message) =>
          scenarioRun.allowQuietWindowMessage?.(message, scenarioContext) ?? false,
        driver: params.driver,
        observedAfter: requestStartedAt,
        sutPhoneE164: params.sutPhoneE164,
        windowMs: scenarioRun.quietWindowMs ?? params.scenario.timeoutMs,
        ...resolveWhatsAppQaNoReplyTarget({
          groupJid: params.groupJid,
          target: scenarioRun.target,
        }),
      });
      return {
        ...buildWhatsAppQaScenarioResultBase(params.scenario),
        status: "pass" as const,
        details: ["no reply", afterSendDetails].filter(Boolean).join("; "),
      };
    }
    const reply = await waitForWhatsAppScenarioSutMessage(scenarioContext, {
      observedAfter: requestStartedAt,
      timeoutMs: params.scenario.timeoutMs,
      targetKind: scenarioRun.target,
      match: (message) => messageMatches(message as WhatsAppObservedMessage, scenarioRun.matchText),
    });
    scenarioRun.verify?.(reply, scenarioContext);
    const afterReplyDetails = await scenarioRun.afterReply?.(reply, scenarioContext);
    const batchDetails = await assertWhatsAppScenarioMessageBatch({
      alreadyRecordedMessageIds: new Set(reply.messageId ? [reply.messageId] : []),
      context: scenarioContext,
      observedAfter: requestStartedAt,
      run: scenarioRun,
    });
    const responseObservedAt = new Date(reply.observedAt);
    const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
    return {
      ...buildWhatsAppQaScenarioResultBase(params.scenario),
      status: "pass" as const,
      details: [`reply matched in ${rttMs}ms`, afterSendDetails, afterReplyDetails, batchDetails]
        .filter(Boolean)
        .join("; "),
      rttMs,
      requestStartedAt: requestStartedAt.toISOString(),
      responseObservedAt: responseObservedAt.toISOString(),
      rttMeasurement: {
        finalMatchedReplyRttMs: rttMs,
        requestStartedAt: requestStartedAt.toISOString(),
        responseObservedAt: responseObservedAt.toISOString(),
        source: "request-to-observed-message" as const,
      },
    };
  } catch (error) {
    try {
      await gatewayHarness.stop({ preserveToDir: params.gatewayDebugDirPath });
      preservedGatewayDebug = true;
      params.onGatewayDebugPreserved?.();
    } catch (preserveError) {
      params.onGatewayDebugPreserveFailure?.(preserveError);
    }
    throw error;
  } finally {
    if (!preservedGatewayDebug) {
      await gatewayHarness.stop().catch(() => {});
    }
  }
}

function toObservedWhatsAppArtifacts(params: {
  includeContent: boolean;
  messages: WhatsAppObservedMessage[];
  redactMetadata: boolean;
}): WhatsAppObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    approvalState: message.approvalState,
    fromPhoneE164: params.redactMetadata ? undefined : message.fromPhoneE164,
    hasMedia: message.hasMedia,
    kind: message.kind,
    matchedScenario: message.matchedScenario,
    mediaFileName: params.redactMetadata ? undefined : message.mediaFileName,
    mediaType: message.mediaType,
    messageId: params.redactMetadata ? undefined : message.messageId,
    observedAt: message.observedAt,
    poll: params.includeContent ? message.poll : undefined,
    quoted: formatObservedWhatsAppQuotedArtifact(message.quoted, {
      includeContent: params.includeContent,
      redactMetadata: params.redactMetadata,
    }),
    reaction: formatObservedWhatsAppReactionArtifact(message.reaction, {
      includeContent: params.includeContent,
      redactMetadata: params.redactMetadata,
    }),
    scenarioId: message.scenarioId,
    scenarioTitle: message.scenarioTitle,
    text: params.includeContent ? message.text : undefined,
  }));
}

function formatObservedWhatsAppReactionArtifact(
  reaction: WhatsAppQaDriverObservedMessage["reaction"],
  params: { includeContent: boolean; redactMetadata: boolean },
): WhatsAppObservedReactionArtifact | undefined {
  if (!reaction) {
    return undefined;
  }
  const artifact: WhatsAppObservedReactionArtifact = {};
  if (params.includeContent) {
    artifact.emoji = reaction.emoji;
  }
  if (reaction.fromMe !== undefined) {
    artifact.fromMe = reaction.fromMe;
  }
  if (!params.redactMetadata) {
    if (reaction.messageId !== undefined) {
      artifact.messageId = reaction.messageId;
    }
    if (reaction.participant !== undefined) {
      artifact.participant = reaction.participant;
    }
  }
  return artifact;
}

function formatObservedWhatsAppQuotedArtifact(
  quoted: WhatsAppQaDriverObservedMessage["quoted"],
  params: { includeContent: boolean; redactMetadata: boolean },
) {
  if (!quoted) {
    return undefined;
  }
  return {
    messageId: params.redactMetadata ? undefined : quoted.messageId,
    participant: params.redactMetadata ? undefined : quoted.participant,
    text: params.includeContent ? quoted.text : undefined,
  };
}

function renderWhatsAppQaMarkdown(params: {
  cleanupIssues: string[];
  credentialFingerprint?: string;
  credentialSource: "convex" | "env";
  finishedAt: string;
  gatewayDebugDirPath?: string;
  redactMetadata: boolean;
  scenarios: WhatsAppQaScenarioResult[];
  startedAt: string;
  sutPhoneE164?: string;
}) {
  const lines = [
    "# WhatsApp QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    ...(params.credentialFingerprint
      ? [`- Credential fingerprint: \`${params.credentialFingerprint}\``]
      : []),
    `- SUT phone: \`${params.redactMetadata ? "<redacted>" : (params.sutPhoneE164 ?? "<unavailable>")}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
  ];
  if (params.gatewayDebugDirPath) {
    lines.push(`- Gateway debug artifacts: \`${params.gatewayDebugDirPath}\``);
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("", "## Cleanup issues", "");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Posture: ${scenario.posture}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function redactWhatsAppQaScenarioResults(
  scenarios: readonly WhatsAppQaScenarioResult[],
): WhatsAppQaScenarioResult[] {
  return scenarios.map((scenario) => ({
    ...scenario,
    details: redactWhatsAppQaScenarioDetails(scenario.details),
  }));
}

const SAFE_WHATSAPP_DRIVER_DIAGNOSTICS_PATTERN =
  /observed \d+ WhatsApp driver message\(s\) after (?:(?:pending|resolved) approval )?wait lower bound(?:: [-A-Za-z0-9_#:=()., +;/]+)?/u;
const SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN =
  /^WhatsApp QA failed during (?:auth archive unpack|credential heartbeat start|credential lease acquisition|driver session start|scenario execution)$/u;
const SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN =
  /Convex credential pool exhausted for kind "whatsapp" after \d+ms\./u;

function formatWhatsAppPreScenarioFailureLabel(phase: WhatsAppQaPreScenarioPhase) {
  return `WhatsApp QA failed during ${phase}`;
}

function isRedactionSafeWhatsAppScenarioDetailSegment(segment: string) {
  return (
    /^no reply$/u.test(segment) ||
    /^reply matched in \d+ms$/u.test(segment) ||
    /^observed \d+ SUT message\(s\) after settle$/u.test(segment)
  );
}

function redactWhatsAppQaScenarioDetails(details: string) {
  const normalized = details.trim();
  const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? "";
  const separatorIndex = firstLine.indexOf(":");
  const preScenarioFailureLabel =
    separatorIndex < 0 ? firstLine.trim() : firstLine.slice(0, separatorIndex).trim();
  if (SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN.test(preScenarioFailureLabel)) {
    const poolExhausted = firstLine.match(SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN);
    return poolExhausted
      ? `${preScenarioFailureLabel}: ${poolExhausted[0]}`
      : preScenarioFailureLabel;
  }
  const safeDriverDiagnostics = normalized.match(SAFE_WHATSAPP_DRIVER_DIAGNOSTICS_PATTERN);
  if (safeDriverDiagnostics) {
    return safeDriverDiagnostics[0];
  }
  const safeSegments = normalized
    .split(";")
    .map((segment) => segment.trim())
    .filter(isRedactionSafeWhatsAppScenarioDetailSegment);
  return safeSegments.length > 0 ? safeSegments.join("; ") : redactQaLiveLaneDetails();
}

function redactWhatsAppQaCleanupIssue(issue: string) {
  const firstLine = issue.split(/\r?\n/u, 1)[0] ?? "";
  const separatorIndex = firstLine.indexOf(":");
  const label = separatorIndex < 0 ? "" : firstLine.slice(0, separatorIndex).trim();
  if (!label) {
    return redactQaLiveLaneDetails();
  }
  if (SAFE_WHATSAPP_PRE_SCENARIO_FAILURE_PATTERN.test(label)) {
    const poolExhausted = firstLine.match(SAFE_WHATSAPP_CREDENTIAL_POOL_EXHAUSTED_PATTERN);
    if (poolExhausted) {
      return `${label}: ${poolExhausted[0]}`;
    }
  }
  return `${label}: ${redactQaLiveLaneDetails()}`;
}

function redactWhatsAppQaCleanupIssues(issues: readonly string[]) {
  return issues.map(redactWhatsAppQaCleanupIssue);
}

function createMissingGroupJidScenarioResult(params: {
  explicitScenarioSelection: boolean;
  scenario: WhatsAppQaScenarioDefinition;
}): WhatsAppQaScenarioResult {
  return {
    ...buildWhatsAppQaScenarioResultBase(params.scenario),
    status: params.explicitScenarioSelection ? "fail" : "skip",
    details: params.explicitScenarioSelection
      ? "requested scenario requires groupJid in the WhatsApp QA credential payload"
      : "requires groupJid in the WhatsApp QA credential payload",
  };
}

function appendPreScenarioFailureResults(params: {
  details: string;
  scenarioResults: WhatsAppQaScenarioResult[];
  scenarios: WhatsAppQaScenarioDefinition[];
}) {
  const recordedScenarioIds = new Set(params.scenarioResults.map((result) => result.id));
  const pendingScenarios = params.scenarios.filter(
    (scenario) => !recordedScenarioIds.has(scenario.id),
  );
  const failedScenarios =
    pendingScenarios.length > 0 ? pendingScenarios : params.scenarios.slice(0, 1);
  for (const scenario of failedScenarios) {
    params.scenarioResults.push({
      ...buildWhatsAppQaScenarioResultBase(scenario),
      status: "fail",
      details: params.details,
    });
  }
}

async function hasWhatsAppGatewayDebugArtifacts(gatewayDebugDirPath: string) {
  try {
    const entries = await fs.readdir(gatewayDebugDirPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function buildPublishedWhatsAppQaRunView(params: {
  cleanupIssues: string[];
  gatewayDebugDirPath: string;
  preservedGatewayDebugArtifacts: boolean;
  redactMetadata: boolean;
  scenarioResults: WhatsAppQaScenarioResult[];
}) {
  const publishedCleanupIssues = params.redactMetadata
    ? redactWhatsAppQaCleanupIssues(params.cleanupIssues)
    : params.cleanupIssues;
  const publishedScenarioResults = params.redactMetadata
    ? redactWhatsAppQaScenarioResults(params.scenarioResults)
    : params.scenarioResults;
  const gatewayDebugDirPath =
    params.preservedGatewayDebugArtifacts &&
    (await hasWhatsAppGatewayDebugArtifacts(params.gatewayDebugDirPath))
      ? params.gatewayDebugDirPath
      : undefined;
  return {
    cleanupIssues: publishedCleanupIssues,
    gatewayDebugDirPath,
    scenarioResults: publishedScenarioResults,
  };
}

function formatWhatsAppScenarioProgressLine(params: {
  details?: string;
  index: number;
  scenario: WhatsAppQaScenarioDefinition;
  status: "fail" | "pass" | "skip" | "start";
  total: number;
}) {
  const prefix = `[whatsapp-qa] [${params.index}/${params.total}] ${params.status}`;
  const detailSuffix = params.details ? ` - ${params.details}` : "";
  return `${prefix} ${params.scenario.id}: ${params.scenario.title}${detailSuffix}`;
}

function formatWhatsAppScenarioProgressDetails(params: {
  details: string;
  redactMetadata: boolean;
}) {
  return params.redactMetadata ? redactWhatsAppQaScenarioDetails(params.details) : params.details;
}

function logWhatsAppScenarioProgress(
  params: Parameters<typeof formatWhatsAppScenarioProgressLine>[0],
) {
  process.stderr.write(`${formatWhatsAppScenarioProgressLine(params)}\n`);
}

export async function runWhatsAppQaLive(params: {
  alternateModel?: string;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<WhatsAppQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `whatsapp-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenarios(params.scenarioIds, providerMode);
  const explicitScenarioSelection = (params.scenarioIds?.length ?? 0) > 0;
  const requestedCredentialSource = inferWhatsAppCredentialSource(params.credentialSource);
  const redactPublicMetadata = resolveWhatsAppMetadataRedaction();
  const includeObservedMessageContent = isTruthyOptIn(process.env[WHATSAPP_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const observedMessages: WhatsAppObservedMessage[] = [];
  const scenarioResults: WhatsAppQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let credentialLease: WhatsAppCredentialLease | undefined;
  let leaseHeartbeat: WhatsAppCredentialHeartbeat | undefined;
  let runtimeEnv: WhatsAppQaRuntimeEnv | undefined;
  let tempAuthRoot: string | undefined;
  let closeDriverSession: (() => Promise<void>) | undefined;
  let preScenarioPhase: WhatsAppQaPreScenarioPhase = "credential lease acquisition";

  try {
    credentialLease = await acquireQaCredentialLease({
      kind: "whatsapp",
      source: params.credentialSource,
      role: params.credentialRole,
      resolveEnvPayload: () => resolveWhatsAppQaRuntimeEnv(),
      parsePayload: parseWhatsAppQaCredentialPayload,
    });
    preScenarioPhase = "credential heartbeat start";
    leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
    const assertLeaseHealthy = () => {
      leaseHeartbeat?.throwIfFailed();
    };
    runtimeEnv = credentialLease.payload;
    tempAuthRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-whatsapp-qa-"),
    );
    preScenarioPhase = "auth archive unpack";
    const [driverAuthDir, sutAuthDir] = await Promise.all([
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.driverAuthArchiveBase64,
        clearSignalSessions: true,
        label: "driver-auth",
        parentDir: tempAuthRoot,
      }),
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.sutAuthArchiveBase64,
        clearSignalSessions: true,
        label: "sut-auth",
        parentDir: tempAuthRoot,
      }),
    ]);
    preScenarioPhase = "driver session start";
    let activeDriver = await startWhatsAppQaDriverSessionWithRetry({ authDir: driverAuthDir });
    closeDriverSession = () => activeDriver.close();
    preScenarioPhase = "scenario execution";

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const progressIndex = scenarioIndex + 1;
      logWhatsAppScenarioProgress({
        index: progressIndex,
        scenario,
        status: "start",
        total: scenarios.length,
      });
      assertLeaseHealthy();
      if (scenario.requiresGroupJid && !runtimeEnv.groupJid) {
        const result = createMissingGroupJidScenarioResult({
          explicitScenarioSelection,
          scenario,
        });
        scenarioResults.push(result);
        logWhatsAppScenarioProgress({
          details: formatWhatsAppScenarioProgressDetails({
            details: result.details,
            redactMetadata: redactPublicMetadata,
          }),
          index: progressIndex,
          scenario,
          status: result.status,
          total: scenarios.length,
        });
        continue;
      }
      let driverAttempt = 1;
      while (true) {
        let scenarioGatewayDebugPreserved = false;
        const scenarioGatewayDebugPreserveFailures: unknown[] = [];
        try {
          const result = await runWhatsAppScenario({
            driver: activeDriver,
            driverPhoneE164: runtimeEnv.driverPhoneE164,
            gatewayDebugDirPath,
            observedMessages,
            providerMode,
            primaryModel,
            alternateModel,
            fastMode: params.fastMode,
            groupJid: runtimeEnv.groupJid,
            repoRoot,
            scenario,
            sutAccountId,
            sutAuthDir,
            sutPhoneE164: runtimeEnv.sutPhoneE164,
            onGatewayDebugPreserved: () => {
              scenarioGatewayDebugPreserved = true;
            },
            onGatewayDebugPreserveFailure: (error) => {
              scenarioGatewayDebugPreserveFailures.push(error);
            },
          });
          const recordedResult =
            driverAttempt > 1
              ? {
                  ...result,
                  details: `${result.details}; driver reconnected ${driverAttempt - 1}x`,
                }
              : result;
          scenarioResults.push(recordedResult);
          logWhatsAppScenarioProgress({
            details: formatWhatsAppScenarioProgressDetails({
              details: recordedResult.details,
              redactMetadata: redactPublicMetadata,
            }),
            index: progressIndex,
            scenario,
            status: recordedResult.status,
            total: scenarios.length,
          });
          break;
        } catch (error) {
          if (
            driverAttempt < WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS &&
            isTransientWhatsAppQaDriverError(error)
          ) {
            driverAttempt += 1;
            await new Promise((resolve) => {
              setTimeout(resolve, WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS);
            });
            activeDriver = await restartWhatsAppQaDriverSession({
              authDir: driverAuthDir,
              current: activeDriver,
            });
            closeDriverSession = () => activeDriver.close();
            continue;
          }
          if (scenarioGatewayDebugPreserved) {
            preservedGatewayDebugArtifacts = true;
          }
          for (const preserveError of scenarioGatewayDebugPreserveFailures) {
            appendLiveLaneIssue(cleanupIssues, "gateway debug preserve failed", preserveError);
          }
          const result: WhatsAppQaScenarioResult = {
            ...buildWhatsAppQaScenarioResultBase(scenario),
            status: "fail",
            details:
              driverAttempt > 1
                ? `${formatErrorMessage(error)}; driver reconnected ${driverAttempt - 1}x`
                : formatErrorMessage(error),
          };
          scenarioResults.push(result);
          logWhatsAppScenarioProgress({
            details: formatWhatsAppScenarioProgressDetails({
              details: result.details,
              redactMetadata: redactPublicMetadata,
            }),
            index: progressIndex,
            scenario,
            status: "fail",
            total: scenarios.length,
          });
          break;
        }
      }
      if (scenarioResults.at(-1)?.status === "fail") {
        break;
      }
    }
  } catch (error) {
    const failureLabel = formatWhatsAppPreScenarioFailureLabel(preScenarioPhase);
    appendLiveLaneIssue(cleanupIssues, failureLabel, error);
    appendPreScenarioFailureResults({
      details: `${failureLabel}: ${formatErrorMessage(error)}`,
      scenarioResults,
      scenarios,
    });
  } finally {
    if (closeDriverSession) {
      try {
        await closeDriverSession();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "driver session stop failed", error);
      }
    }
    if (leaseHeartbeat) {
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential heartbeat stop failed", error);
      }
    }
    if (credentialLease) {
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential release failed", error);
      }
    }
    if (tempAuthRoot) {
      await fs.rm(tempAuthRoot, { recursive: true, force: true }).catch((error: unknown) => {
        appendLiveLaneIssue(cleanupIssues, "temporary auth cleanup failed", error);
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "whatsapp-qa-report.md");
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const observedMessagesPath = path.join(outputDir, "whatsapp-qa-observed-messages.json");
  const credentialFingerprint = fingerprintQaCredentialId(credentialLease?.credentialId);
  const publishedRunView = await buildPublishedWhatsAppQaRunView({
    cleanupIssues,
    gatewayDebugDirPath,
    preservedGatewayDebugArtifacts,
    redactMetadata: redactPublicMetadata,
    scenarioResults,
  });
  const evidence = buildLiveTransportEvidenceSummary({
    artifactPaths: [
      { kind: "summary", path: path.basename(summaryPath) },
      { kind: "report", path: path.basename(reportPath) },
      { kind: "transport-observations", path: path.basename(observedMessagesPath) },
    ],
    checks: toWhatsAppLiveTransportEvidenceChecks(publishedRunView.scenarioResults),
    env: process.env,
    generatedAt: finishedAt,
    primaryModel,
    providerMode,
    repoRoot,
    transportId: "whatsapp",
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      toObservedWhatsAppArtifacts({
        messages: observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    `${renderWhatsAppQaMarkdown({
      cleanupIssues: publishedRunView.cleanupIssues,
      credentialFingerprint,
      credentialSource: credentialLease?.source ?? requestedCredentialSource,
      finishedAt,
      gatewayDebugDirPath: publishedRunView.gatewayDebugDirPath,
      redactMetadata: redactPublicMetadata,
      scenarios: publishedRunView.scenarioResults,
      startedAt,
      sutPhoneE164: runtimeEnv?.sutPhoneE164,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: publishedRunView.gatewayDebugDirPath,
    scenarios: scenarioResults,
  };
}

export const testing = {
  assertSafeArchiveEntries,
  appendPreScenarioFailureResults,
  buildPublishedWhatsAppQaRunView,
  buildWhatsAppQaConfig,
  buildWhatsAppQaMockAuthAgentIds,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  createMissingGroupJidScenarioResult,
  findScenarios,
  findUnexpectedWhatsAppNoReplyMessage,
  formatWhatsAppApprovalWaitDiagnostics,
  formatWhatsAppBatchMessageDiagnostics,
  formatWhatsAppPreScenarioFailureLabel,
  formatWhatsAppScenarioProgressDetails,
  formatWhatsAppScenarioProgressLine,
  dedupeWhatsAppMessagesById,
  fingerprintWhatsAppCredentialId: fingerprintQaCredentialId,
  formatWhatsAppScenarioWaitDiagnostics,
  hasWhatsAppGatewayDebugArtifacts,
  isWhatsAppChannelReady,
  isTransientWhatsAppQaDriverError,
  matchesWhatsAppApprovalResolvedText,
  parseWhatsAppQaCredentialPayload,
  renderWhatsAppQaMarkdown,
  runWhatsAppApprovalScenario,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
  waitForWhatsAppChannelStable,
  redactWhatsAppQaScenarioResults,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaRuntimeEnv,
  resolveWhatsAppMetadataRedaction,
  toObservedWhatsAppArtifacts,
  toWhatsAppLiveTransportEvidenceChecks,
  unpackWhatsAppAuthArchive,
  WHATSAPP_QA_STANDARD_SCENARIO_IDS,
  WHATSAPP_QA_SCENARIO_POSTURES,
};
export { testing as __testing };
