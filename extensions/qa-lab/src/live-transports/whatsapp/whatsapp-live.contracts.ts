// QA Lab WhatsApp live domain contracts.
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { startQaGatewayChild } from "../../gateway-child.js";

export type WhatsAppQaRuntimeEnv = {
  driverAuthArchiveBase64: string;
  driverPhoneE164: string;
  sutAuthArchiveBase64: string;
  sutPhoneE164: string;
  groupJid?: string;
};

export type WhatsAppQaScenarioId =
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

export type WhatsAppQaApprovalKind = "exec" | "plugin";
export type WhatsAppQaApprovalDecision = "allow-once" | "deny";
type WhatsAppQaApprovalDecisionMode = "reaction" | "rpc";
type WhatsAppQaScenarioPosture = "direct-gateway" | "native-approval" | "user-path";

export function toWhatsAppQaError(error: unknown): Error {
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

export type WhatsAppQaGateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
export type WhatsAppQaGatewayRuntime = Pick<
  WhatsAppQaGateway,
  "call" | "restart" | "workspaceDir"
> &
  Partial<Pick<WhatsAppQaGateway, "logs" | "token" | "wsUrl">>;
export type WhatsAppQaGatewayCallContext = {
  gateway: Pick<WhatsAppQaGatewayRuntime, "call">;
  gatewayTarget: string;
  scenarioId: WhatsAppQaScenarioId;
  sutAccountId: string;
};
export type WhatsAppQaObservedMessagesContext = {
  driver: Pick<WhatsAppQaDriverSession, "getObservedMessages">;
  sutPhoneE164: string;
  target: string;
  targetKind: "dm" | "group";
};
export type WhatsAppQaDriverQuotedMessageKey = NonNullable<
  NonNullable<Parameters<WhatsAppQaDriverSession["sendText"]>[2]>["quotedMessageKey"]
>;

export type WhatsAppQaMessageScenarioContext = {
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

export function resolveWhatsAppQaScenarioTarget(params: {
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

export function resolveWhatsAppQaMessageTargets(params: {
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

export type WhatsAppQaMessageScenarioRun = {
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

export type WhatsAppQaApprovalScenarioRun = {
  approvalKind: WhatsAppQaApprovalKind;
  decision: WhatsAppQaApprovalDecision;
  decisionMode?: WhatsAppQaApprovalDecisionMode;
  kind: "approval";
  target?: "dm" | "group";
  token: string;
};

type WhatsAppQaScenarioRun = WhatsAppQaApprovalScenarioRun | WhatsAppQaMessageScenarioRun;

export type WhatsAppQaConfigOverrides = {
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

export type WhatsAppQaScenarioDefinition = {
  id: WhatsAppQaScenarioId;
  title: string;
  timeoutMs: number;
  buildRun: () => WhatsAppQaScenarioRun;
  configOverrides?: WhatsAppQaConfigOverrides;
  requiresGroupJid?: boolean;
  requiredPluginIds?: readonly string[];
};

export interface WhatsAppObservedMessage extends WhatsAppQaDriverObservedMessage {
  approvalState?: "pending" | "resolved";
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
}

export type WhatsAppQaScenarioResult = {
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
  status: "fail" | "pass" | "skip";
  title: string;
};

export function buildWhatsAppQaScenarioResultBase(scenario: WhatsAppQaScenarioDefinition) {
  return {
    id: scenario.id,
    title: scenario.title,
    posture: WHATSAPP_QA_SCENARIO_POSTURES[scenario.id],
  };
}
