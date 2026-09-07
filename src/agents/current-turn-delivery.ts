import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import {
  resolveMessageActionTurnCapability,
  selectMessageActionRequesterIdentity,
} from "../gateway/message-action-turn-capability.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentScopedOutboundMediaAccess } from "../media/read-capability.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { stringEnum } from "./schema/typebox.js";
import {
  asToolParamsRecord,
  jsonResult,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./tools/common.js";

const currentTurnDeliveryOutputSchema = Type.Object(
  {
    status: stringEnum(["sent", "suppressed", "not_sent", "partial_failed", "failed"] as const),
    messageId: Type.Optional(Type.String()),
    suppressionReason: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    sentBeforeError: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

export type CurrentTurnDeliveryResult = Static<typeof currentTurnDeliveryOutputSchema>;

export type CurrentTurnDelivery = {
  send(
    input: { text?: string; mediaUrl?: string },
    bestEffort?: boolean,
  ): Promise<CurrentTurnDeliveryResult>;
};

/** Private construction slot for the exact host-created delivery tool instance. */
export type CurrentTurnDeliveryToolRef = {
  value?: AnyAgentTool;
};

export function rebindCurrentTurnDeliveryToolRef(
  ref: CurrentTurnDeliveryToolRef | undefined,
  before: readonly AnyAgentTool[],
  after: readonly AnyAgentTool[],
): void {
  if (!ref) {
    return;
  }
  const rebound = ref.value ? after[before.indexOf(ref.value)] : undefined;
  if (rebound) {
    ref.value = rebound;
  } else {
    delete ref.value;
  }
}

const loadMessageActionRunner = createLazyRuntimeModule(
  () => import("../infra/outbound/message-action-runner.js"),
);

export function createCurrentTurnDelivery(params: {
  context: OpenClawPluginToolContext;
  agentSessionKey?: string;
  runId?: string;
  token?: string;
  revokedErrorMessage?: string;
}): CurrentTurnDelivery | undefined {
  const route = normalizeDeliveryContext(params.context.deliveryContext);
  const { agentId, sessionKey, sessionId } = params.context;
  const policySessionKey = params.agentSessionKey ?? sessionKey;
  const registry = getActivePluginRegistry();
  const registryVersion = getActivePluginRegistryVersion();
  if (!route?.channel || !route.to || !registry || !params.context.runtimeConfig) {
    return undefined;
  }
  if (!agentId || !sessionKey || !policySessionKey || !params.runId || !params.token) {
    return undefined;
  }
  const channel = registry.channels.find((entry) => entry.plugin.id === route.channel);
  if (!channel || channel.plugin.outbound?.deliveryMode === "gateway") {
    return undefined;
  }

  // Registry reload or turn close revokes retained tool copies before provider I/O.
  const authorize = () => {
    const authorization =
      getActivePluginRegistry() === registry && getActivePluginRegistryVersion() === registryVersion
        ? resolveMessageActionTurnCapability({
            token: params.token,
            agentId,
            runId: params.runId,
            sessionKey: policySessionKey,
            sessionId,
          })
        : undefined;
    if (!authorization) {
      throw new Error(
        params.revokedErrorMessage ?? "current-turn delivery capability is no longer active",
      );
    }
    return authorization;
  };
  const initialAuthorization = authorize();
  const requesterIdentity = selectMessageActionRequesterIdentity(initialAuthorization);
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.context.runtimeConfig,
    agentId,
    workspaceDir: params.context.workspaceDir,
    sessionKey,
    accountId: initialAuthorization.requesterAccountId ?? route.accountId,
    ...requesterIdentity,
  });

  return {
    async send({ text, mediaUrl }, bestEffort) {
      authorize();
      const { runMessageAction } = await loadMessageActionRunner();
      const authorization = authorize();
      const cfg = params.context.getRuntimeConfig?.();
      if (!cfg) {
        throw new Error("current-turn delivery requires an active runtime config");
      }
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        runMessageAction({
          cfg,
          action: "send",
          params: {
            channel: route.channel,
            target: route.to,
            ...(route.accountId ? { accountId: route.accountId } : {}),
            ...(route.threadId != null ? { threadId: route.threadId } : {}),
            ...(text !== undefined ? { message: text } : {}),
            ...(mediaUrl !== undefined ? { mediaUrl } : {}),
            ...(bestEffort !== undefined ? { bestEffort } : {}),
          },
          defaultAccountId: route.accountId,
          ...requesterIdentity,
          messageActionAuthorization: {
            requesterAccountId: authorization.requesterAccountId,
            requesterSenderId: authorization.requesterSenderId,
            toolContext: authorization.toolContext,
          },
          senderIsOwner: params.context.senderIsOwner,
          conversationReadOrigin: params.context.conversationReadOrigin,
          toolContext: authorization.toolContext,
          sessionKey,
          sessionId,
          runId: params.runId,
          agentId,
          mediaAccess,
          onPlatformSendDispatch: async () => void authorize(),
          assertDirectAdapterHandoff: () => void authorize(),
          forceCoreDelivery: true,
          skipQueue: true,
          dryRun: false,
        }),
      );
      const sendResult = result.kind === "send" ? result.sendResult : undefined;
      const messageId = sendResult?.result?.messageId;
      const status =
        sendResult?.deliveryStatus === "suppressed" &&
        sendResult.suppressionReason === "adapter_returned_no_send"
          ? "not_sent"
          : (sendResult?.deliveryStatus ?? (messageId ? "sent" : "failed"));
      const projected: CurrentTurnDeliveryResult = {
        status,
        ...(messageId ? { messageId } : {}),
        ...(sendResult?.suppressionReason
          ? { suppressionReason: sendResult.suppressionReason }
          : {}),
        ...(sendResult?.error ? { error: sendResult.error } : {}),
        ...(sendResult?.sentBeforeError ? { sentBeforeError: true } : {}),
        ...(!sendResult ? { error: "current-turn delivery returned no send result" } : {}),
      };
      try {
        authorize();
        return projected;
      } catch (error) {
        if (projected.status !== "sent" && projected.sentBeforeError !== true) {
          throw error;
        }
        return {
          ...projected,
          status: "partial_failed",
          error: formatErrorMessage(error),
          sentBeforeError: true,
        };
      }
    },
  };
}

export function createCurrentTurnDeliveryTool(delivery: CurrentTurnDelivery): AnyAgentTool {
  let consumed = false;
  return {
    name: "send_current_reply",
    label: "Send current reply",
    description:
      "Send one reply to the host-selected conversation for this OpenClaw Code Mode turn.",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1 }),
        mediaUrl: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    outputSchema: currentTurnDeliveryOutputSchema,
    async execute(_toolCallId, args) {
      const input = asToolParamsRecord(args);
      const text = readToolStringParam(input, "text", { required: true });
      const mediaUrl = readToolStringParam(input, "mediaUrl");
      if (consumed) {
        throw new ToolInputError("current-turn delivery authority has already been consumed");
      }
      consumed = true;
      let result: CurrentTurnDeliveryResult;
      try {
        result = await delivery.send({ text, mediaUrl }, true);
      } catch (error) {
        const sentBeforeError = asOptionalRecord(error)?.sentBeforeError === true;
        result = {
          status: sentBeforeError ? "partial_failed" : "failed",
          error: formatErrorMessage(error),
          ...(sentBeforeError ? { sentBeforeError: true } : {}),
        };
      }
      const terminal =
        result.status === "sent" ||
        (result.status === "partial_failed" && result.sentBeforeError === true);
      const toolResult = jsonResult(result);
      return terminal ? { ...toolResult, terminate: true } : toolResult;
    },
  };
}
