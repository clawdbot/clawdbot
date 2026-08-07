import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentExecutionAttribution,
  type AgentExecutionAttribution,
} from "../../agents/agent-execution-attribution.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import {
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
} from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

type AutoReplyExecutionIdentityContext = {
  accountId?: string;
  agentId?: string;
  chatId?: string;
  channel?: string;
  inputProvenance?: InputProvenance;
  isHeartbeat: boolean;
  messageId?: string;
  senderId?: string;
  senderIsBot?: boolean;
  senderLabel?: string;
  sessionId?: string;
  sessionKey?: string;
  threadId?: string | number;
};

function encodeRawRef(parts: Record<string, string | number | boolean | undefined>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(parts).filter((entry) => entry[1] !== undefined)),
  );
}

function resolveAdmissionFacts(params: {
  context: AutoReplyExecutionIdentityContext;
  runId: string;
}): ExecutionIdentityAdmissionFacts {
  const context = params.context;
  const channel = normalizeOptionalString(context.channel);
  const senderId = normalizeOptionalString(context.senderId);
  const provenance = context.inputProvenance;
  const sourceRef = encodeRawRef({
    channel,
    accountId: normalizeOptionalString(context.accountId),
    chatId: normalizeOptionalString(context.chatId),
    messageId: normalizeOptionalString(context.messageId),
    threadId:
      typeof context.threadId === "string" || typeof context.threadId === "number"
        ? context.threadId
        : undefined,
  });
  const sourceAgent = normalizeOptionalString(provenance?.sourceSessionKey);
  const isInterSession = provenance?.kind === "inter_session" && sourceAgent !== undefined;
  const isSystem = context.isHeartbeat || provenance?.kind === "internal_system";
  const ingress: ExecutionIdentityAdmissionFacts["ingress"] = isInterSession
    ? {
        kind: "subagent",
        boundary: "auto-reply.inter-session",
        state: "present",
        rawSourceRef: sourceRef,
      }
    : isSystem
      ? {
          kind: "system",
          boundary: context.isHeartbeat ? "auto-reply.heartbeat" : "auto-reply.internal-system",
          state: "present",
          rawSourceRef: sourceRef,
        }
      : channel
        ? {
            kind: "channel",
            boundary: "auto-reply.channel",
            state: "present",
            rawSourceRef: sourceRef,
          }
        : {
            kind: "api",
            boundary: "auto-reply.unknown",
            state: "unknown",
          };
  const invoker: ExecutionIdentityAdmissionFacts["invoker"] = isInterSession
    ? {
        kind: "agent",
        rawPrincipalRef: sourceAgent,
      }
    : isSystem
      ? {
          kind: "system",
          rawPrincipalRef: normalizeOptionalString(provenance?.sourceTool) ?? "openclaw",
        }
      : senderId
        ? {
            kind: context.senderIsBot ? "service" : "person",
            rawPrincipalRef: encodeRawRef({
              channel,
              accountId: normalizeOptionalString(context.accountId),
              senderId,
            }),
            ...(normalizeOptionalString(context.senderLabel)
              ? { displayLabel: normalizeOptionalString(context.senderLabel) }
              : {}),
          }
        : undefined;
  return {
    runId: params.runId,
    agentId: normalizeOptionalString(context.agentId) ?? "unknown",
    ingress,
    // Runtime identity names the OpenClaw admission owner/process, not a later
    // model-fallback backend. Auto-reply and /btw are both embedded-owned.
    runtime: { kind: "embedded" },
    ...(invoker ? { invoker } : {}),
    ...(ingress.kind === "channel" && sourceRef !== "{}"
      ? {
          assurance: [
            {
              kind: "channel-admission",
              rawEvidenceRef: sourceRef,
              strength: "boundary-verified",
            },
          ],
        }
      : {}),
  };
}

/** Allocate and optionally persist the exact identity for one admitted auto-reply turn. */
export function admitAutoReplyExecutionAttribution(params: {
  attribution?: AgentExecutionAttribution;
  config: OpenClawConfig;
  context: AutoReplyExecutionIdentityContext;
  lifecycleGeneration: string;
  runId: string;
}): AgentExecutionAttribution {
  if (params.attribution) {
    return params.attribution;
  }
  const attribution = createAgentExecutionAttribution({
    runId: params.runId,
    lifecycleGeneration: params.lifecycleGeneration,
    sessionKey: params.context.sessionKey,
    sessionId: params.context.sessionId,
    agentId: params.context.agentId,
  });
  enqueueExecutionIdentityContextAtAdmission(resolveAdmissionFacts(params), {
    enabled: isExecutionIdentityCollectionEnabled(params.config),
    contextId: attribution.contextId,
    executionId: attribution.executionId,
    now: attribution.createdAt,
  });
  return attribution;
}
