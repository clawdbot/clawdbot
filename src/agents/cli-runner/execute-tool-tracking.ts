import { isDeepStrictEqual } from "node:util";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  type McpLoopbackToolCallStart,
  type McpLoopbackToolCallTerminalOutcome,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { shouldUseInternalSourceReplySink } from "../../infra/outbound/internal-source-reply.js";
import type { CliOutput, CliToolUseStartDelta } from "../cli-output-contracts.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  resolveMessageToolSourceReplyFinal,
} from "../embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging-extraction.js";
import {
  isMessagingTool,
  isMessagingToolDeliveryAction,
  isMessagingToolSendAction,
  isPluginNativeMessagingTool,
} from "../embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "../embedded-agent-tool-media.js";
import { readToolResultDetails } from "../tool-result-error.js";
import { closeClaudeSession } from "./claude-live-registry.js";
import { attachCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import {
  appendUniqueCliMessagingEvidence,
  buildMessagingToolSendEvidenceKey,
  CLI_MESSAGING_EVIDENCE_MAX_CALLS,
  extractCliMessagingContent,
  extractCliMessagingTarget,
  normalizeCliMessagingToolName,
} from "./execute-messaging.js";
import type { PreparedCliRunContext } from "./types.js";

const CLI_LOOPBACK_CORRELATION_MAX_CALLS = 64;
const CLI_MCP_DELIVERY_DRAIN_GRACE_MS = 5_000;
const CLI_MCP_REQUEST_ADMISSION_GRACE_MS = 250;

type CliToolTerminalOutcome = McpLoopbackToolCallTerminalOutcome | { outcome: "completed" };
type CliLoopbackCall = {
  admitted: McpLoopbackToolCallStart;
  current: McpLoopbackToolCallStart;
  boundToolCallId?: string;
  outcome?: CliToolTerminalOutcome;
  ambiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};
type CliLoopbackAmbiguityGroup = {
  calls: Set<CliLoopbackCall>;
  activeToolCallIds: Set<string>;
};
type ActiveCliTool = {
  toolName: string;
  args: Record<string, unknown>;
  loopbackCall?: CliLoopbackCall;
  loopbackAmbiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};

export function createCliToolTracking(context: PreparedCliRunContext) {
  let gatewayCaptureKey: string | undefined;
  let yielded = false;
  let yieldAcknowledgment: string | undefined;
  let didSendViaMessagingTool = false;
  let didDeliverSourceReplyViaMessageTool = false;
  let inFlightUnclassifiedMcpRequests = 0;
  let inFlightMessagingToolCalls = 0;
  const inFlightPreparedMessagingCalls = new Set<McpLoopbackToolCallStart>();
  const pendingMessagingCalls = new Map<
    string,
    { toolName: string; args: Record<string, unknown>; target?: MessagingToolSend }
  >();
  const cliLoopbackCalls: CliLoopbackCall[] = [];
  const activeCliTools = new Map<string, ActiveCliTool>();
  let cliLoopbackCorrelationOverflowed = false;
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentTextKeys = new Set<string>();
  const messagingToolSentMediaUrls: string[] = [];
  const messagingToolSentMediaUrlKeys = new Set<string>();
  const messagingToolSentTargets: MessagingToolSend[] = [];
  const messagingToolSentTargetKeys = new Set<string>();
  const messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[] = [];
  const toolMediaUrls: string[] = [];
  const toolMediaUrlKeys = new Set<string>();
  let toolAudioAsVoice = false;
  let toolTrustedLocalMedia = false;
  const matchesCliLoopbackCall = (
    toolName: string,
    toolArgs: Record<string, unknown>,
    call: McpLoopbackToolCallStart,
  ) =>
    normalizeCliMessagingToolName(toolName) === call.toolName &&
    isDeepStrictEqual(toolArgs, call.args);
  const markCliLoopbackCallsAmbiguous = (
    calls: CliLoopbackCall[],
    activeEntries = Array.from(activeCliTools.entries()).filter(
      ([, activeTool]) =>
        activeTool.loopbackCall !== undefined && calls.includes(activeTool.loopbackCall),
    ),
  ) => {
    const groups = new Set<CliLoopbackAmbiguityGroup>();
    for (const call of calls) {
      if (call.ambiguityGroup) {
        groups.add(call.ambiguityGroup);
      }
    }
    for (const [, activeTool] of activeEntries) {
      if (activeTool.ambiguityGroup) {
        groups.add(activeTool.ambiguityGroup);
      }
    }
    const group = groups.values().next().value ?? {
      calls: new Set<CliLoopbackCall>(),
      activeToolCallIds: new Set<string>(),
    };
    for (const existing of groups) {
      if (existing === group) {
        continue;
      }
      for (const call of existing.calls) {
        call.ambiguityGroup = group;
        group.calls.add(call);
      }
      for (const toolCallId of existing.activeToolCallIds) {
        const activeTool = activeCliTools.get(toolCallId);
        if (activeTool) {
          activeTool.ambiguityGroup = group;
          group.activeToolCallIds.add(toolCallId);
        }
      }
      existing.calls.clear();
      existing.activeToolCallIds.clear();
    }
    for (const call of calls) {
      call.ambiguous = true;
      call.ambiguityGroup = group;
      group.calls.add(call);
    }
    for (const [toolCallId, activeTool] of activeEntries) {
      activeTool.loopbackAmbiguous = true;
      activeTool.ambiguityGroup = group;
      group.activeToolCallIds.add(toolCallId);
    }
  };
  const matchingActiveCliTools = (call: McpLoopbackToolCallStart): Array<[string, ActiveCliTool]> =>
    Array.from(activeCliTools.entries()).filter(([, activeTool]) =>
      matchesCliLoopbackCall(activeTool.toolName, activeTool.args, call),
    );
  const markCliLoopbackSignatureAmbiguous = (call: McpLoopbackToolCallStart) => {
    const calls = cliLoopbackCalls.filter((candidate) =>
      matchesCliLoopbackCall(call.toolName, call.args, candidate.admitted),
    );
    markCliLoopbackCallsAmbiguous(calls, matchingActiveCliTools(call));
  };
  const retainCliLoopbackCall = (call: McpLoopbackToolCallStart) => {
    if (cliLoopbackCalls.length >= CLI_LOOPBACK_CORRELATION_MAX_CALLS) {
      cliLoopbackCorrelationOverflowed = true;
      for (const activeTool of activeCliTools.values()) {
        if (activeTool.loopbackCall || activeTool.toolName.startsWith("mcp__")) {
          activeTool.loopbackAmbiguous = true;
        }
      }
      cliLoopbackCalls.length = 0;
      return undefined;
    }
    const retained: CliLoopbackCall = { admitted: call, current: call, ambiguous: false };
    cliLoopbackCalls.push(retained);
    return retained;
  };
  const bindCliLoopbackCall = (
    call: CliLoopbackCall,
    toolCallId: string,
    activeTool: ActiveCliTool,
  ) => {
    call.boundToolCallId = toolCallId;
    activeTool.loopbackCall = call;
    activeTool.loopbackAmbiguous ||= call.ambiguous;
    if (call.ambiguityGroup) {
      activeTool.ambiguityGroup = call.ambiguityGroup;
      call.ambiguityGroup.activeToolCallIds.add(toolCallId);
    }
  };
  const removeCliLoopbackCall = (call: CliLoopbackCall | undefined) => {
    if (!call) {
      return;
    }
    const index = cliLoopbackCalls.indexOf(call);
    if (index >= 0) {
      cliLoopbackCalls.splice(index, 1);
    }
  };
  const retireCliLoopbackCorrelation = (
    toolCallId: string,
    activeTool: ActiveCliTool | undefined,
  ) => {
    removeCliLoopbackCall(activeTool?.loopbackCall);
    const group = activeTool?.ambiguityGroup;
    if (!group) {
      return;
    }
    group.activeToolCallIds.delete(toolCallId);
    const hasUnboundCall = Array.from(group.calls).some(
      (call) => call.boundToolCallId === undefined && cliLoopbackCalls.includes(call),
    );
    if (group.activeToolCallIds.size > 0 || hasUnboundCall) {
      return;
    }
    // An ambiguous group owns unbound captures too. Retire the whole group
    // once its parsed tools finish so stale calls cannot poison later tools.
    for (const call of group.calls) {
      removeCliLoopbackCall(call);
    }
    group.calls.clear();
  };
  const commitMessagingToolResult = (params: {
    toolName: string;
    target?: MessagingToolSend;
    args?: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  }) => {
    const deliveryFact = readEmbeddedMessageDeliveryFact(
      readToolResultDetails(params.result)?.messageDelivery,
    );
    const delivered = deliveryFact
      ? deliveryFact.status === "settled" &&
        (params.isError !== true || deliveryFact.partialDelivery)
      : isPluginNativeMessagingTool(params.toolName) && isDeliveredMessagingToolResult(params);
    if (!delivered) {
      return;
    }
    didSendViaMessagingTool = true;
    const toolArgs = params.args ?? {};
    const isMessagingSend = isMessagingToolSendAction(params.toolName, toolArgs);
    const content = isMessagingSend ? extractCliMessagingContent(toolArgs, params.result) : {};
    const deliveredCurrentSourceReply =
      isMessagingSend &&
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: context.params.sourceReplyDeliveryMode,
        toolName: params.toolName,
        args: params.args,
        result: params.result,
        isError: params.isError,
        deliveryConfirmed: true,
      });
    const sourceReplyFinal = deliveredCurrentSourceReply
      ? resolveMessageToolSourceReplyFinal(toolArgs)
      : undefined;
    if (isMessagingSend) {
      appendUniqueCliMessagingEvidence(
        messagingToolSentTexts,
        messagingToolSentTextKeys,
        content.text ? [content.text] : [],
      );
      appendUniqueCliMessagingEvidence(
        messagingToolSentMediaUrls,
        messagingToolSentMediaUrlKeys,
        content.mediaUrls ?? [],
      );
      if (deliveredCurrentSourceReply) {
        didDeliverSourceReplyViaMessageTool = true;
        const payload = extractMessagingToolSourceReplyPayload(params.result);
        if (payload) {
          if (messagingToolSourceReplyPayloads.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
            messagingToolSourceReplyPayloads.shift();
          }
          // Each internal source-reply send is a distinct delivery, even when
          // two intentional sends have identical text or media.
          messagingToolSourceReplyPayloads.push({
            ...payload,
            ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
          });
        }
      }
    }
    if (!params.target) {
      return;
    }
    const targetWithContent = {
      ...extractMessagingToolSendResult(params.target, params.result),
      ...content,
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    };
    const evidenceKey = buildMessagingToolSendEvidenceKey(targetWithContent);
    if (messagingToolSentTargetKeys.has(evidenceKey)) {
      return;
    }
    if (messagingToolSentTargets.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
      const removed = messagingToolSentTargets.shift();
      if (removed) {
        messagingToolSentTargetKeys.delete(buildMessagingToolSendEvidenceKey(removed));
      }
    }
    messagingToolSentTargets.push(targetWithContent);
    messagingToolSentTargetKeys.add(evidenceKey);
  };
  const isPreparedInternalSourceReply = async (call: McpLoopbackToolCallStart) => {
    if (
      context.params.sourceReplyDeliveryMode !== "message_tool_only" ||
      normalizeCliMessagingToolName(call.toolName) !== "message" ||
      call.args.action !== "send" ||
      !context.params.config
    ) {
      return false;
    }
    return await shouldUseInternalSourceReplySink(
      {
        cfg: context.params.config,
        action: "send",
        sessionKey: context.params.sessionKey,
        sourceReplyDeliveryMode: context.params.sourceReplyDeliveryMode,
        toolContext: {
          currentChannelProvider: context.params.messageChannel ?? context.params.messageProvider,
          currentChannelId: context.params.currentChannelId,
          currentThreadTs: context.params.currentThreadTs,
          currentMessageId: context.params.currentMessageId,
          replyToMode: context.params.replyToMode,
        },
      },
      call.args,
    );
  };
  const beginGatewayCapture = (captureKey: string | undefined) => {
    if (!captureKey || gatewayCaptureKey === captureKey) {
      return;
    }
    if (gatewayCaptureKey) {
      throw new Error("CLI MCP capture key changed during an active attempt");
    }
    context.preparedBackend.mcpClientGrantCapture?.activate(captureKey);
    gatewayCaptureKey = captureKey;
    const isPotentialDelivery = (toolName: string) =>
      isMessagingTool(normalizeCliMessagingToolName(toolName));
    const isPreparedDelivery = (toolName: string, toolArgs: Record<string, unknown>) =>
      toolArgs.dryRun !== true &&
      isMessagingToolDeliveryAction(normalizeCliMessagingToolName(toolName), toolArgs);
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onYield: (_message, acknowledgment) => {
        yielded = true;
        yieldAcknowledgment = acknowledgment;
      },
      onRequestStart: () => {
        inFlightUnclassifiedMcpRequests += 1;
      },
      onRequestClassified: () => {
        inFlightUnclassifiedMcpRequests = Math.max(0, inFlightUnclassifiedMcpRequests - 1);
      },
      onToolCallStart: (call) => {
        const retained = retainCliLoopbackCall(call);
        const candidates = matchingActiveCliTools(call);
        // Parallel same-name calls can reach the loopback out of stream order.
        // Bind only a unique name+arguments match; ambiguity is safer than a wrong outcome.
        let matched =
          retained &&
          candidates.length === 1 &&
          !candidates[0]?.[1].loopbackCall &&
          !candidates[0]?.[1].loopbackAmbiguous
            ? candidates[0]
            : undefined;
        if (retained && matched) {
          bindCliLoopbackCall(retained, matched[0], matched[1]);
        } else if (retained && candidates.length > 0) {
          markCliLoopbackSignatureAmbiguous(call);
          matched = candidates.find(([, activeTool]) => !activeTool.loopbackCall);
          if (matched) {
            bindCliLoopbackCall(retained, matched[0], matched[1]);
          }
        }
        if (isPotentialDelivery(call.toolName)) {
          inFlightMessagingToolCalls += 1;
        }
        return matched?.[0];
      },
      onToolCallUpdate: ({ previous, current }) => {
        const candidates = cliLoopbackCalls.filter((candidate) =>
          matchesCliLoopbackCall(previous.toolName, previous.args, candidate.current),
        );
        const candidate = candidates.at(0);
        if (candidates.length === 1 && candidate && !candidate.ambiguous) {
          candidate.current = current;
        } else if (candidates.length > 0) {
          markCliLoopbackCallsAmbiguous(candidates);
        }
        inFlightPreparedMessagingCalls.delete(previous);
        const wasDelivery = isPotentialDelivery(previous.toolName);
        const isDelivery = isPreparedDelivery(current.toolName, current.args);
        if (wasDelivery !== isDelivery) {
          inFlightMessagingToolCalls = Math.max(
            0,
            inFlightMessagingToolCalls + (isDelivery ? 1 : -1),
          );
        }
        if (isDelivery) {
          inFlightPreparedMessagingCalls.add(current);
        }
      },
      onToolCallFinish: (call, { prepared }) => {
        const isDelivery = prepared
          ? isPreparedDelivery(call.toolName, call.args)
          : isPotentialDelivery(call.toolName);
        if (isDelivery) {
          inFlightMessagingToolCalls = Math.max(0, inFlightMessagingToolCalls - 1);
        }
        inFlightPreparedMessagingCalls.delete(call);
      },
      onToolCallResult: (call) => {
        const terminalOutcome: CliToolTerminalOutcome =
          call.outcome === "blocked"
            ? { outcome: call.outcome, deniedReason: call.deniedReason }
            : { outcome: call.outcome };
        const correlated = call.correlationId
          ? cliLoopbackCalls.find((candidate) => candidate.boundToolCallId === call.correlationId)
          : undefined;
        const candidates = correlated
          ? [correlated]
          : cliLoopbackCalls.filter((candidate) =>
              matchesCliLoopbackCall(call.toolName, call.args, candidate.current),
            );
        if (candidates.length === 1 && candidates[0]) {
          candidates[0].outcome = terminalOutcome;
        } else if (candidates.length > 1) {
          markCliLoopbackCallsAmbiguous(candidates);
        }
        const toolName = normalizeCliMessagingToolName(call.toolName);
        if (isMessagingToolDeliveryAction(toolName, call.args)) {
          commitMessagingToolResult({
            toolName,
            target: extractCliMessagingTarget(context, toolName, call.args),
            args: call.args,
            result: "result" in call ? call.result : undefined,
            isError: call.outcome !== "completed",
          });
        } else if (call.outcome === "completed" && "result" in call) {
          const artifact = extractToolResultMediaArtifact(call.result);
          const mediaUrls = artifact
            ? filterToolResultMediaUrls(toolName, artifact.mediaUrls, call.result)
            : [];
          appendUniqueCliMessagingEvidence(toolMediaUrls, toolMediaUrlKeys, mediaUrls);
          if (mediaUrls.length > 0) {
            toolAudioAsVoice ||= artifact?.audioAsVoice === true;
            toolTrustedLocalMedia ||= artifact?.trustedLocalMedia === true;
          }
        }
      },
    });
  };
  const handleCliToolUseStart = (event: CliToolUseStartDelta) => {
    if (event.kind !== "server_tool_use") {
      const activeTool: ActiveCliTool = {
        toolName: event.name,
        args: event.args,
        loopbackAmbiguous: cliLoopbackCorrelationOverflowed && event.name.startsWith("mcp__"),
      };
      activeCliTools.set(event.toolCallId, activeTool);
      const admittedCall = {
        toolName: normalizeCliMessagingToolName(event.name),
        args: event.args,
      };
      const pendingCandidates = cliLoopbackCalls.filter(
        (candidate) =>
          candidate.boundToolCallId === undefined &&
          matchesCliLoopbackCall(event.name, event.args, candidate.admitted),
      );
      const hasAssociatedPeer = matchingActiveCliTools(admittedCall).some(
        ([toolCallId, peer]) =>
          toolCallId !== event.toolCallId &&
          (peer.loopbackCall !== undefined || peer.loopbackAmbiguous),
      );
      const pending = pendingCandidates[0];
      if (hasAssociatedPeer || pendingCandidates.length > 1 || pending?.ambiguous) {
        markCliLoopbackSignatureAmbiguous(admittedCall);
        if (pending) {
          bindCliLoopbackCall(pending, event.toolCallId, activeTool);
        }
      } else if (pendingCandidates.length === 1 && pending) {
        bindCliLoopbackCall(pending, event.toolCallId, activeTool);
      }
    }
    const toolName = normalizeCliMessagingToolName(event.name);
    if (
      event.kind === "server_tool_use" ||
      gatewayCaptureKey ||
      event.args.dryRun === true ||
      !isMessagingToolDeliveryAction(toolName, event.args)
    ) {
      return;
    }
    if (pendingMessagingCalls.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
      const oldestToolCallId = pendingMessagingCalls.keys().next().value;
      if (oldestToolCallId !== undefined) {
        pendingMessagingCalls.delete(oldestToolCallId);
        // Once an unresolved send is evicted, its later result cannot be correlated.
        // Fail closed so a failed turn cannot duplicate it.
        didSendViaMessagingTool = true;
      }
    }
    pendingMessagingCalls.set(event.toolCallId, {
      toolName,
      args: event.args,
      target: extractCliMessagingTarget(context, toolName, event.args),
    });
  };
  const handleCliToolResult = (event: {
    toolCallId: string;
    name: string;
    isError: boolean;
    result?: unknown;
  }) => {
    const activeTool = activeCliTools.get(event.toolCallId);
    activeCliTools.delete(event.toolCallId);
    retireCliLoopbackCorrelation(event.toolCallId, activeTool);
    const pending = pendingMessagingCalls.get(event.toolCallId);
    if (pending) {
      pendingMessagingCalls.delete(event.toolCallId);
      commitMessagingToolResult({
        toolName: pending.toolName,
        target: pending.target,
        args: pending.args,
        result: event.result,
        isError: event.isError,
      });
    }
  };
  const resolveCliLoopbackTerminalOutcome = (toolCallId: string) => {
    const activeTool = activeCliTools.get(toolCallId);
    if (activeTool?.loopbackAmbiguous) {
      return { outcome: "unknown" } as const;
    }
    return activeTool?.loopbackCall?.outcome;
  };

  const finishDeliveryTracking = async (params: {
    useManagedClaudeLiveSession: boolean;
    recordRunError: (error: unknown) => void;
  }) => {
    try {
      if (!gatewayCaptureKey && pendingMessagingCalls.size > 0) {
        const calls = Array.from(pendingMessagingCalls.values());
        const internalStates = await Promise.all(calls.map(isPreparedInternalSourceReply));
        if (internalStates.some((internal) => !internal)) {
          didSendViaMessagingTool = true;
          params.recordRunError(
            new Error("CLI JSONL message tool call remained unresolved after exit"),
          );
        } else {
          params.recordRunError(
            new Error("CLI JSONL source reply call remained unresolved after exit"),
          );
        }
      }
      if (!gatewayCaptureKey) {
        return;
      }
      const captureBecameIdle = await waitForMcpLoopbackToolCallCaptureIdle(gatewayCaptureKey, {
        timeoutMs: CLI_MCP_DELIVERY_DRAIN_GRACE_MS,
        admissionGraceMs: CLI_MCP_REQUEST_ADMISSION_GRACE_MS,
      });
      if (captureBecameIdle) {
        return;
      }
      if (params.useManagedClaudeLiveSession) {
        await closeClaudeSession(context, "mcp-capture-rotation");
      }
      const internalStates = await Promise.all(
        Array.from(inFlightPreparedMessagingCalls).map(isPreparedInternalSourceReply),
      );
      const internalCount = internalStates.filter(Boolean).length;
      const hasPotentialVisibleSend = inFlightMessagingToolCalls > internalCount;
      if (inFlightUnclassifiedMcpRequests > 0 || hasPotentialVisibleSend) {
        didSendViaMessagingTool = true;
        params.recordRunError(new Error("CLI message tool call remained in flight after exit"));
      } else if (inFlightMessagingToolCalls > 0) {
        params.recordRunError(new Error("CLI source reply call remained in flight after exit"));
      }
    } catch (error) {
      if (
        pendingMessagingCalls.size > 0 ||
        inFlightUnclassifiedMcpRequests > 0 ||
        inFlightMessagingToolCalls > 0
      ) {
        didSendViaMessagingTool = true;
      }
      params.recordRunError(error);
    }
  };

  const finalizeCapture = (finalizeParsedTools: () => void) => {
    // Captured MCP calls may settle after the CLI process exits. Drain first so
    // finalization can use their trusted terminal outcomes.
    try {
      finalizeParsedTools();
    } finally {
      if (gatewayCaptureKey) {
        // Fence this exact grant generation before clearing observers; otherwise
        // a late request escapes accounting.
        try {
          context.preparedBackend.mcpClientGrantCapture?.deactivate(gatewayCaptureKey);
        } finally {
          clearMcpLoopbackToolCallCapture(gatewayCaptureKey);
        }
      }
    }
  };

  const evidence = () => ({
    didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets,
    messagingToolSourceReplyPayloads,
    toolMediaUrls,
    toolAudioAsVoice,
    toolTrustedLocalMedia,
  });
  return {
    beginGatewayCapture,
    handleCliToolUseStart,
    handleCliToolResult,
    resolveCliLoopbackTerminalOutcome,
    finishDeliveryTracking,
    finalizeCapture,
    withExecutionEvidence(output: CliOutput): CliOutput {
      const current = evidence();
      return {
        ...output,
        ...(yielded ? { yielded: true as const } : {}),
        ...(yieldAcknowledgment ? { yieldAcknowledgment } : {}),
        ...(current.didSendViaMessagingTool ? { didSendViaMessagingTool: true } : {}),
        ...(current.didDeliverSourceReplyViaMessageTool
          ? { didDeliverSourceReplyViaMessageTool: true }
          : {}),
        ...(current.messagingToolSentTexts.length > 0
          ? { messagingToolSentTexts: current.messagingToolSentTexts.slice() }
          : {}),
        ...(current.messagingToolSentMediaUrls.length > 0
          ? { messagingToolSentMediaUrls: current.messagingToolSentMediaUrls.slice() }
          : {}),
        ...(current.messagingToolSentTargets.length > 0
          ? { messagingToolSentTargets: current.messagingToolSentTargets.slice() }
          : {}),
        ...(current.messagingToolSourceReplyPayloads.length > 0
          ? { messagingToolSourceReplyPayloads: current.messagingToolSourceReplyPayloads.slice() }
          : {}),
        ...(current.toolMediaUrls.length > 0
          ? { toolMediaUrls: current.toolMediaUrls.slice() }
          : {}),
        ...(current.toolAudioAsVoice ? { toolAudioAsVoice: true } : {}),
        ...(current.toolTrustedLocalMedia ? { toolTrustedLocalMedia: true } : {}),
      };
    },
    attachDeliveryEvidence(error: unknown) {
      return attachCliMessagingDeliveryEvidence(error, evidence());
    },
  };
}

export type CliToolTracking = ReturnType<typeof createCliToolTracking>;
