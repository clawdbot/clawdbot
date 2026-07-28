// Live-only command evidence shared by the gateway stress test and its unit coverage.
import {
  isExpectedNativeCommand,
  requireSuccessfulNativeCommandExecution,
} from "./gateway-codex-harness.live-helpers.js";

function readPersistedToolCalls(
  message: unknown,
  commandMarker: string,
  expectedCommand: string,
): Array<{ id: string; matches: boolean }> {
  if (!message || typeof message !== "object") {
    return [];
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    return [];
  }
  const calls: Array<{ id: string; matches: boolean }> = [];
  for (const item of record.content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = item as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (
      content.type !== "toolCall" ||
      content.name !== "bash" ||
      typeof content.id !== "string" ||
      !content.arguments ||
      typeof content.arguments !== "object"
    ) {
      continue;
    }
    const command = (content.arguments as { command?: unknown }).command;
    calls.push({
      id: content.id,
      matches:
        typeof command === "string" &&
        command.includes(commandMarker) &&
        isExpectedNativeCommand(command, expectedCommand),
    });
  }
  return calls;
}

function readPersistedTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const blocks = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const block = item as { text?: unknown };
    return typeof block.text === "string" ? [block.text] : [];
  });
  return blocks.length > 0 ? blocks.join("\n") : undefined;
}

function isSuccessfulPersistedResult(record: { details?: unknown; isError?: unknown }): boolean {
  if (record.isError !== false) {
    return false;
  }
  if (!record.details || typeof record.details !== "object") {
    return true;
  }
  const details = record.details as {
    exitCode?: unknown;
    status?: unknown;
    timedOut?: unknown;
  };
  return (
    (details.exitCode === undefined || details.exitCode === null || details.exitCode === 0) &&
    (details.status === undefined || details.status === "completed") &&
    details.timedOut !== true
  );
}

/** Requires durable history to prove one successful native bash execution and its large output. */
export function requireSuccessfulPersistedNativeCommandExecution(
  messages: readonly unknown[],
  params: {
    commandMarker: string;
    expectedCommand: string;
    minimumOutputChars: number;
    toolCallId?: string;
  },
): { callIndex: number; resultIndex: number; toolCallId: string } {
  const calls: Array<{ id: string; callIndex: number; matches: boolean }> = [];
  for (let callIndex = 0; callIndex < messages.length; callIndex += 1) {
    for (const call of readPersistedToolCalls(
      messages[callIndex],
      params.commandMarker,
      params.expectedCommand,
    )) {
      calls.push({ ...call, callIndex });
    }
  }
  const observedResults: unknown[] = [];
  for (let resultIndex = 0; resultIndex < messages.length; resultIndex += 1) {
    const message = messages[resultIndex];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as {
      role?: unknown;
      toolCallId?: unknown;
      isError?: unknown;
      content?: unknown;
      details?: unknown;
    };
    if (record.role !== "toolResult" || typeof record.toolCallId !== "string") {
      continue;
    }
    if (params.toolCallId !== undefined && record.toolCallId !== params.toolCallId) {
      continue;
    }
    const content = readPersistedTextContent(record.content);
    const originalLengths =
      typeof content === "string"
        ? Array.from(content.matchAll(/original (\d+) chars/gu), (match) => Number(match[1]))
        : [];
    const hasMarker = typeof content === "string" && content.includes(params.commandMarker);
    const associatedCall = calls.find((call) => call.id === record.toolCallId);
    const callIndex = associatedCall?.matches === true ? associatedCall.callIndex : -1;
    if (
      (associatedCall?.matches === true ||
        (associatedCall === undefined && params.toolCallId !== undefined)) &&
      isSuccessfulPersistedResult(record) &&
      hasMarker &&
      originalLengths.some((length) => length >= params.minimumOutputChars)
    ) {
      return { callIndex, resultIndex, toolCallId: record.toolCallId };
    }
    if (hasMarker || callIndex >= 0) {
      observedResults.push({
        resultIndex,
        toolCallId: record.toolCallId,
        isError: record.isError,
        details:
          record.details && typeof record.details === "object"
            ? {
                status: (record.details as { status?: unknown }).status,
                exitCode: (record.details as { exitCode?: unknown }).exitCode,
                timedOut: (record.details as { timedOut?: unknown }).timedOut,
              }
            : undefined,
        originalLengths,
        ...(typeof content === "string"
          ? {
              contentLength: content.length,
            }
          : {}),
      });
    }
  }

  throw new Error(
    `persisted native bash command for marker ${params.commandMarker} has no successful large result; observed=${JSON.stringify(observedResults)}`,
  );
}

function hasPersistedToolResult(messages: readonly unknown[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message !== null &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "toolResult" &&
      (message as { toolCallId?: unknown }).toolCallId === toolCallId,
  );
}

/** Proves the large command either survived in history or was replaced by later compaction. */
export function requireSuccessfulNativeCommandCompactionEvidence(params: {
  commandMarker: string;
  events: readonly unknown[];
  expectedCommand: string;
  messages: readonly unknown[];
  minimumOutputChars: number;
}): { source: "compacted-event" | "persisted-history" } {
  let requestEvidence: ReturnType<typeof requireSuccessfulNativeCommandExecution>;
  try {
    requestEvidence = requireSuccessfulNativeCommandExecution(params.events, params);
  } catch (eventError) {
    throw new Error(
      `large native command has no successful request-local evidence: ${String(eventError)}`,
      {
        cause: eventError,
      },
    );
  }

  let persistedError: unknown;
  try {
    requireSuccessfulPersistedNativeCommandExecution(params.messages, {
      ...params,
      toolCallId: requestEvidence.itemId,
    });
    return { source: "persisted-history" };
  } catch (error) {
    persistedError = error;
  }

  if (hasPersistedToolResult(params.messages, requestEvidence.itemId)) {
    throw new Error(
      `durable result for successful request-local command failed validation: ${String(persistedError)}`,
      { cause: persistedError },
    );
  }

  const compactedAfterResult = params.events.some(
    (event, index) =>
      index > requestEvidence.resultIndex &&
      event !== null &&
      typeof event === "object" &&
      (event as { stream?: unknown }).stream === "compaction" &&
      (event as { data?: { phase?: unknown; completed?: unknown } }).data?.phase === "end" &&
      (event as { data?: { phase?: unknown; completed?: unknown } }).data?.completed === true,
  );
  if (!compactedAfterResult) {
    throw new Error(
      `successful request-local command result was not followed by compaction; persisted=${String(persistedError)}`,
    );
  }
  return { source: "compacted-event" };
}
