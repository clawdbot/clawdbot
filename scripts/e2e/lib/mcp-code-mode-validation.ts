type McpCodeModeExecCall = {
  callId: string;
  code: string;
};

type McpCodeModeToolResult = {
  callId: string;
  isError: boolean;
  output: string;
};

export type McpCodeModeEvidence = {
  execCalls: McpCodeModeExecCall[];
  toolResults: McpCodeModeToolResult[];
};

type McpCodeModeRequestSnapshot = {
  plannedToolArgs?: { code?: unknown };
  plannedToolCallId?: unknown;
  plannedToolName?: unknown;
  toolOutput?: unknown;
  toolOutputCallId?: unknown;
  toolOutputStructuredError?: unknown;
};

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((piece) => {
      const text = (piece as { text?: unknown } | null)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/** Extracts paired exec evidence from structured transcript messages only. */
export function extractMcpCodeModeTranscriptEvidence(
  transcriptEvents: readonly unknown[],
): McpCodeModeEvidence {
  const evidence: McpCodeModeEvidence = { execCalls: [], toolResults: [] };
  for (const event of transcriptEvents) {
    const message =
      event && typeof event === "object"
        ? (
            event as {
              message?: {
                content?: unknown;
                isError?: unknown;
                role?: unknown;
                toolCallId?: unknown;
              };
            }
          ).message
        : undefined;
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = message.content;
    if (message.role === "assistant" && Array.isArray(content)) {
      for (const value of content) {
        const block = value as {
          arguments?: { code?: unknown };
          id?: unknown;
          input?: { code?: unknown };
          name?: unknown;
          type?: unknown;
        } | null;
        if (
          !block ||
          !["toolCall", "tool_use", "tool_call"].includes(String(block.type)) ||
          block.name !== "exec"
        ) {
          continue;
        }
        const code = block.arguments?.code ?? block.input?.code;
        if (typeof block.id === "string" && typeof code === "string") {
          const callId = block.id;
          evidence.execCalls.push({ callId, code });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId === "string") {
        evidence.toolResults.push({
          callId: message.toolCallId,
          isError: message.isError === true,
          output: readContentText(content),
        });
      }
    }
  }
  return evidence;
}

/** Extracts the same paired proof from QA provider request snapshots. */
export function extractMcpCodeModeRequestEvidence(
  requests: readonly McpCodeModeRequestSnapshot[],
): McpCodeModeEvidence {
  const evidence: McpCodeModeEvidence = { execCalls: [], toolResults: [] };
  for (const request of requests) {
    if (request.plannedToolName === "exec") {
      const { plannedToolCallId: callId, plannedToolArgs } = request;
      if (typeof callId === "string" && typeof plannedToolArgs?.code === "string") {
        evidence.execCalls.push({ callId, code: plannedToolArgs.code });
      }
    }
    const { toolOutputCallId: callId, toolOutput: output } = request;
    if (typeof callId === "string" && typeof output === "string") {
      evidence.toolResults.push({
        callId,
        isError: request.toolOutputStructuredError === true,
        output,
      });
    }
  }
  return evidence;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
}

export function validateMcpCodeModeResult(
  response: unknown,
  evidence: McpCodeModeEvidence,
): string {
  const finalText = outputText(response);
  assert(
    finalText.includes("MCP_CODE_MODE_FILE_OK"),
    `agent did not complete MCP API file check: ${finalText}`,
  );
  assert(
    finalText.includes("fixture-note-alpha"),
    `agent did not return fixture note from MCP call: ${finalText}`,
  );
  assert(
    !/MCP\s+(?:was\s+)?not\s+defined|failed|error/i.test(finalText),
    `agent reported MCP failure instead of a successful call: ${finalText}`,
  );
  assert(
    evidence.execCalls.every(
      ({ code }) => !code.includes("MCP.$api") && !code.includes("catalog.search"),
    ),
    "agent should not use MCP.$api or catalog.search for MCP lookup",
  );
  const matchingCall = evidence.execCalls.find(({ callId, code }) => {
    const hasRequiredSource =
      code.includes('API.list("mcp")') &&
      code.includes('API.read("mcp/index.d.ts")') &&
      code.includes('API.read("mcp/fixture.d.ts")') &&
      code.includes("MCP.fixture.lookupNote");
    return (
      hasRequiredSource &&
      evidence.toolResults.some(
        (result) =>
          result.callId === callId &&
          !result.isError &&
          result.output.includes("MCP_CODE_MODE_FILE_TOOL_RESULT") &&
          result.output.includes("fixture-note-alpha"),
      )
    );
  });
  assert(matchingCall, "agent lacks matched MCP code-mode exec call and successful result proof");
  return finalText;
}
