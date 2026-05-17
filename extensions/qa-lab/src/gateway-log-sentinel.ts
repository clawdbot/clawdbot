export type GatewayLogSentinelKind =
  | "plugin-hook-failure"
  | "plugin-contract-error"
  | "direct-reply-self-message"
  | "codex-app-server-timeout"
  | "stalled-agent-run"
  | "cron-model-allowlist"
  | "live-quota-or-subscription";

export type GatewayLogSentinelVerdict =
  | "product-bug"
  | "qa-harness-bug"
  | "fixture-bug"
  | "environment-blocked";

export type GatewayLogSentinelOwner =
  | "plugin"
  | "openclaw-routing"
  | "codex-runtime"
  | "openclaw-cron"
  | "environment";

export type GatewayLogSentinelFinding = {
  kind: GatewayLogSentinelKind;
  verdict: GatewayLogSentinelVerdict;
  owner: GatewayLogSentinelOwner;
  productImpact: "P0" | "P1" | "P2" | "P3" | "P4";
  qaImpact: "P0" | "P1" | "P2" | "P3" | "P4";
  line: number;
  text: string;
};

export type GatewayLogSentinelScanOptions = {
  since?: number;
  kinds?: readonly GatewayLogSentinelKind[];
  ignoreKinds?: readonly GatewayLogSentinelKind[];
};

export type GatewayLogSentinelAssertOptions = GatewayLogSentinelScanOptions & {
  allowEnvironmentBlocked?: boolean;
};

type GatewayLogSentinelRule = Omit<GatewayLogSentinelFinding, "line" | "text"> & {
  test: (line: string) => boolean;
};

type GatewayLogSentinelToolCall = {
  name: string;
  args: unknown;
};

const GATEWAY_LOG_SENTINEL_RULES: GatewayLogSentinelRule[] = [
  {
    kind: "plugin-hook-failure",
    verdict: "qa-harness-bug",
    owner: "plugin",
    productImpact: "P1",
    qaImpact: "P0",
    test: (line) =>
      /\bbefore_(?:prompt_build|tool_call)\b/iu.test(line) &&
      /\b(?:crash(?:ed)?|exception|failed|failure|error)\b/iu.test(line),
  },
  {
    kind: "plugin-contract-error",
    verdict: "qa-harness-bug",
    owner: "plugin",
    productImpact: "P1",
    qaImpact: "P0",
    test: (line) =>
      /\bcontracts\.tools\b/iu.test(line) &&
      /\b(?:missing|invalid|registration|register|manifest|contract|schema|declare|error)\b/iu.test(
        line,
      ),
  },
  {
    kind: "codex-app-server-timeout",
    verdict: "product-bug",
    owner: "codex-runtime",
    productImpact: "P1",
    qaImpact: "P0",
    test: (line) =>
      /\bcodex app-server\b.*\btimed out\b|\btimed out\b.*\bcodex app-server\b/iu.test(line),
  },
  {
    kind: "stalled-agent-run",
    verdict: "product-bug",
    owner: "codex-runtime",
    productImpact: "P1",
    qaImpact: "P0",
    test: (line) =>
      /\bcodex_app_server\b.*\b(?:stalled|no progress|progress stalled)\b|\b(?:stalled|no progress|progress stalled)\b.*\bcodex_app_server\b/iu.test(
        line,
      ),
  },
  {
    kind: "cron-model-allowlist",
    verdict: "product-bug",
    owner: "openclaw-cron",
    productImpact: "P2",
    qaImpact: "P0",
    test: (line) =>
      /\bcron\b/iu.test(line) &&
      (/\bmodel allowlist\b/iu.test(line) ||
        /\ballowlist\b.*\bmodel\b/iu.test(line) ||
        /\bmodel\b.*\b(?:not in|outside|blocked by)\b.*\ballowlist\b/iu.test(line)),
  },
  {
    kind: "live-quota-or-subscription",
    verdict: "environment-blocked",
    owner: "environment",
    productImpact: "P4",
    qaImpact: "P0",
    test: (line) =>
      /\b(?:quota exceeded|insufficient_quota|subscription exhausted|no active subscription|billing hard limit|usage limit)\b/iu.test(
        line,
      ),
  },
];

function filterGatewayLogSentinelFindings(
  findings: GatewayLogSentinelFinding[],
  options: GatewayLogSentinelScanOptions | undefined,
) {
  const kinds = new Set(options?.kinds ?? []);
  const ignoreKinds = new Set(options?.ignoreKinds ?? []);
  return findings.filter((finding) => {
    if (kinds.size > 0 && !kinds.has(finding.kind)) {
      return false;
    }
    return !ignoreKinds.has(finding.kind);
  });
}

function lineNumberForOffset(logs: string, offset: number) {
  if (offset <= 0) {
    return 1;
  }
  return logs.slice(0, offset).split(/\r?\n/u).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractMessageText(message: Record<string, unknown>) {
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const text = readNonEmptyString(block.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const nestedText = readNonEmptyString(block.content);
    if (
      nestedText &&
      (block.type === "output_text" || block.type === "text" || block.type === "message")
    ) {
      parts.push(nestedText);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractAssistantToolCalls(message: Record<string, unknown>): GatewayLogSentinelToolCall[] {
  const calls: GatewayLogSentinelToolCall[] = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isRecord(block)) {
        continue;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      if (
        type !== "tool_use" &&
        type !== "toolcall" &&
        type !== "tool_call" &&
        type !== "function_call"
      ) {
        continue;
      }
      calls.push({
        name: readNonEmptyString(block.name) ?? "unknown",
        args: parseJsonArguments(block.input ?? block.arguments ?? block.args ?? null),
      });
    }
  }

  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    const functionRecord = isRecord(call.function) ? call.function : undefined;
    calls.push({
      name: readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name) ?? "unknown",
      args: parseJsonArguments(
        call.arguments ?? functionRecord?.arguments ?? call.input ?? functionRecord?.input ?? null,
      ),
    });
  }
  return calls;
}

function isCurrentChatMessageSend(call: GatewayLogSentinelToolCall) {
  if (call.name !== "message") {
    return false;
  }
  if (!isRecord(call.args) || readNonEmptyString(call.args.action)?.toLowerCase() !== "send") {
    return false;
  }
  const explicitTarget =
    readNonEmptyString(call.args.conversationId) ??
    readNonEmptyString(call.args.conversation) ??
    readNonEmptyString(call.args.to) ??
    readNonEmptyString(call.args.target);
  if (!explicitTarget) {
    return true;
  }
  return /\b(?:current|same-chat|qa-operator|dm:qa-operator)\b/iu.test(explicitTarget);
}

function normalizeTranscriptText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function transcriptHasDirectReplySelfMessage(transcriptBytes: string) {
  let lastAssistantText = "";
  const toolCalls: GatewayLogSentinelToolCall[] = [];
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : undefined;
      if (!message || message.role !== "assistant") {
        continue;
      }
      const text = extractMessageText(message);
      if (text) {
        lastAssistantText = text;
      }
      toolCalls.push(...extractAssistantToolCalls(message));
    } catch {
      // Ignore malformed QA transcript rows and keep sentinel scans deterministic.
    }
  }
  return (
    toolCalls.some(isCurrentChatMessageSend) &&
    normalizeTranscriptText(lastAssistantText).toLowerCase() === "sent."
  );
}

export function scanGatewayLogSentinels(
  logs: string | undefined,
  options?: GatewayLogSentinelScanOptions,
): GatewayLogSentinelFinding[] {
  if (!logs) {
    return [];
  }
  const startOffset = Math.max(0, Math.min(logs.length, Math.floor(options?.since ?? 0)));
  const lineOffset = lineNumberForOffset(logs, startOffset) - 1;
  const findings: GatewayLogSentinelFinding[] = [];
  for (const [index, rawLine] of logs.slice(startOffset).split(/\r?\n/u).entries()) {
    const text = rawLine.trim();
    if (!text) {
      continue;
    }
    for (const rule of GATEWAY_LOG_SENTINEL_RULES) {
      if (!rule.test(text)) {
        continue;
      }
      findings.push({
        kind: rule.kind,
        verdict: rule.verdict,
        owner: rule.owner,
        productImpact: rule.productImpact,
        qaImpact: rule.qaImpact,
        line: lineOffset + index + 1,
        text,
      });
    }
  }
  return filterGatewayLogSentinelFindings(findings, options);
}

export function scanDirectReplyTranscriptSentinels(
  transcriptBytes: string,
): GatewayLogSentinelFinding[] {
  if (!transcriptHasDirectReplySelfMessage(transcriptBytes)) {
    return [];
  }
  return [
    {
      kind: "direct-reply-self-message",
      verdict: "product-bug",
      owner: "openclaw-routing",
      productImpact: "P1",
      qaImpact: "P0",
      line: 1,
      text: "assistant called message(action=send) and then produced final text Sent.",
    },
  ];
}

export function formatGatewayLogSentinelSummary(findings: readonly GatewayLogSentinelFinding[]) {
  if (findings.length === 0) {
    return "no gateway log sentinels";
  }
  return findings
    .map(
      (finding) =>
        `${finding.kind}@${finding.line} ${finding.verdict} owner=${finding.owner}: ${finding.text}`,
    )
    .join("\n");
}

export function assertNoGatewayLogSentinels(
  logs: string | undefined,
  options?: GatewayLogSentinelAssertOptions,
) {
  const findings = scanGatewayLogSentinels(logs, options);
  if (findings.length === 0) {
    return findings;
  }
  if (
    options?.allowEnvironmentBlocked === true &&
    findings.every((finding) => finding.verdict === "environment-blocked")
  ) {
    return findings;
  }
  throw new Error(
    `Gateway log sentinel(s) detected:\n${formatGatewayLogSentinelSummary(findings)}`,
  );
}
