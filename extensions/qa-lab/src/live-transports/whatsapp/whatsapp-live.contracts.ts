// QA Lab WhatsApp live domain contracts.
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { QaGatewayChild } from "../../gateway-child.js";
export { toQaError as toWhatsAppQaError } from "../../errors.js";

export type WhatsAppQaRuntimeEnv = {
  driverAuthArchiveBase64: string;
  driverPhoneE164: string;
  sutAuthArchiveBase64: string;
  sutPhoneE164: string;
  groupJid?: string;
};

export type WhatsAppQaApprovalDecision = "allow-once" | "deny";
type WhatsAppQaApprovalDecisionMode = "reaction" | "rpc";
type WhatsAppQaScenarioPosture = "direct-gateway" | "native-approval" | "user-path";

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

export type WhatsAppQaGateway = QaGatewayChild;
export type WhatsAppQaGatewayRuntime = Pick<
  WhatsAppQaGateway,
  "call" | "restart" | "workspaceDir"
> &
  Partial<Pick<WhatsAppQaGateway, "logs" | "token" | "wsUrl">>;
export type WhatsAppQaGatewayCallContext = {
  gateway: Pick<WhatsAppQaGatewayRuntime, "call">;
  gatewayTarget: string;
  scenarioId: string;
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
  scenarioId: string;
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
  scenarioId: string;
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
  approvalKind: ChannelApprovalKind;
  decision: WhatsAppQaApprovalDecision;
  decisionMode?: WhatsAppQaApprovalDecisionMode;
  kind: "approval";
  target?: "dm" | "group";
  token: string;
};

export type WhatsAppQaScenarioRun = WhatsAppQaApprovalScenarioRun | WhatsAppQaMessageScenarioRun;

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
  statusReactions?: boolean;
};

export type WhatsAppQaScenarioImplementation = {
  buildRun: () => WhatsAppQaScenarioRun;
  configOverrides?: WhatsAppQaConfigOverrides;
  posture: WhatsAppQaScenarioPosture;
  requiresGroupJid?: boolean;
};

export type WhatsAppQaScenarioMetadata = {
  id: string;
  timeoutMs: number;
  title: string;
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

export function buildWhatsAppQaScenarioResultBase(
  scenario: WhatsAppQaScenarioMetadata,
  implementation: WhatsAppQaScenarioImplementation,
) {
  return {
    id: scenario.id,
    title: scenario.title,
    posture: implementation.posture,
  };
}
