import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import {
  pruneExpiredCacheTtlToolResults,
  resolveCacheTtlPruningSettings,
} from "./tool-result-truncation.js";

const NOW = 1_000_000;

function assistant(content: unknown = [{ type: "text", text: "assistant" }]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp: 1,
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function tool(params: {
  id: string;
  text?: unknown;
  toolName?: string;
  image?: boolean;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.id,
    toolName: params.toolName ?? "read",
    content: [
      ...(params.image ? [{ type: "image", data: "AA==", mimeType: "image/png" }] : []),
      { type: "text", text: params.text ?? "result" },
    ],
    details: { source: params.id },
    isError: params.id === "error",
    timestamp: 42,
  } as AgentMessage;
}

function prunableHistory(oldTools: AgentMessage[], tail: AgentMessage[] = []): AgentMessage[] {
  return [
    user("first"),
    assistant(),
    ...oldTools,
    user("second"),
    assistant(),
    ...tail,
    user("third"),
    assistant(),
    user("fourth"),
    assistant(),
  ];
}

function settings(config: AgentContextPruningConfig = { mode: "cache-ttl" }) {
  const resolved = resolveCacheTtlPruningSettings(config);
  if (!resolved) {
    throw new Error("expected cache-TTL settings");
  }
  return resolved;
}

function project(
  messages: AgentMessage[],
  options: {
    config?: AgentContextPruningConfig;
    contextWindowTokens?: number;
    dropThinkingBlocksForEstimate?: boolean;
    lastCacheTouchAt?: number | null;
    now?: number;
  } = {},
): AgentMessage[] {
  return pruneExpiredCacheTtlToolResults({
    messages,
    settings: settings(options.config),
    contextWindowTokens: options.contextWindowTokens ?? 1_000,
    lastCacheTouchAt:
      options.lastCacheTouchAt === undefined ? NOW - 300_000 : options.lastCacheTouchAt,
    dropThinkingBlocksForEstimate: options.dropThinkingBlocksForEstimate ?? false,
    now: options.now ?? NOW,
  });
}

function toolText(messages: AgentMessage[], id: string): string {
  const message = messages.find(
    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === id,
  );
  if (!message || message.role !== "toolResult") {
    throw new Error(`missing tool result ${id}`);
  }
  return message.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

describe("cache-TTL tool-result projection", () => {
  it("normalizes TTL, hard-clear, and deny-first tool matching once", () => {
    expect(resolveCacheTtlPruningSettings(undefined)).toBeUndefined();
    expect(resolveCacheTtlPruningSettings({ mode: "off" })).toBeUndefined();
    expect(settings({ mode: "cache-ttl", ttl: "invalid" }).ttlMs).toBe(300_000);
    expect(settings({ mode: "cache-ttl", ttl: "1h" }).ttlMs).toBe(3_600_000);

    const configured = settings({
      mode: "cache-ttl",
      tools: { allow: ["READ*"], deny: ["read_secret"] },
      hardClear: { enabled: false, placeholder: "  custom  " },
    });
    expect(configured.hardClear).toBe(false);
    expect(configured.placeholder).toBe("custom");
    expect(configured.isToolPrunable("read_file")).toBe(true);
    expect(configured.isToolPrunable("READ_SECRET")).toBe(false);
    expect(configured.isToolPrunable("exec")).toBe(false);
    expect(settings().isToolPrunable("anything")).toBe(true);
  });

  it("requires an expired positive TTL and treats equality as expired", () => {
    const messages = prunableHistory([tool({ id: "old", text: "x".repeat(5_000) })]);
    expect(project(messages, { lastCacheTouchAt: null })).toBe(messages);
    expect(project(messages, { lastCacheTouchAt: NOW - 299_999 })).toBe(messages);
    expect(project(messages, { config: { mode: "cache-ttl", ttl: "0m" } })).toBe(messages);
    expect(project(messages, { lastCacheTouchAt: NOW - 300_000 })).not.toBe(messages);
  });

  it("protects bootstrap history and the last three assistant turns", () => {
    const bootstrap = tool({ id: "bootstrap", text: "b".repeat(5_000) });
    const old = tool({ id: "old", text: "o".repeat(5_000) });
    const recent = tool({ id: "recent", text: "r".repeat(5_000) });
    const messages = [assistant(), bootstrap, ...prunableHistory([old], [recent])];
    const result = project(messages);

    expect(toolText(result, "bootstrap")).toBe("b".repeat(5_000));
    expect(toolText(result, "old")).toContain("[Tool result trimmed:");
    expect(toolText(result, "recent")).toBe("r".repeat(5_000));
  });

  it("soft-trims joined blocks with UTF-16-safe exact head and tail", () => {
    const text = `${"h".repeat(1_499)}😀${"m".repeat(1_001)}😀${"t".repeat(1_499)}`;
    const result = project(prunableHistory([tool({ id: "utf16", text })]));
    expect(toolText(result, "utf16")).toBe(
      `${"h".repeat(1_499)}\n...\n${"t".repeat(1_499)}\n\n` +
        "[Tool result trimmed: kept first 1500 chars and last 1500 chars of 4003 chars.]",
    );
  });

  it("replaces images and serializes malformed text before hard eligibility", () => {
    const malformed = { payload: "m".repeat(5_000) };
    const result = project(prunableHistory([tool({ id: "image", text: malformed, image: true })]), {
      contextWindowTokens: 4_000,
    });
    const text = toolText(result, "image");
    expect(text).toContain("[image removed during context pruning]");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("uses CJK weighting when deciding whether to enter the soft pass", () => {
    const messages = prunableHistory([tool({ id: "cjk", text: "x".repeat(4_001) })]);
    messages[0] = user("𠀀".repeat(50));
    const result = project(messages, { contextWindowTokens: 3_500 });
    expect(toolText(result, "cjk")).toContain("[Tool result trimmed:");
  });

  it("drops old thinking only for pressure estimation", () => {
    const messages = prunableHistory([tool({ id: "thinking", text: "x".repeat(4_001) })]);
    messages[1] = assistant([
      { type: "thinking", thinking: "hidden", thinkingSignature: "s".repeat(40_000) },
      { type: "text", text: { malformed: "m".repeat(40_000) } },
      { type: "text", text: "done" },
    ]);
    expect(toolText(project(messages, { contextWindowTokens: 20_000 }), "thinking")).toContain(
      "[Tool result trimmed:",
    );
    expect(
      project(messages, {
        contextWindowTokens: 20_000,
        dropThinkingBlocksForEstimate: true,
      }),
    ).toBe(messages);
  });

  it("hard-clears oldest eligible results with a custom placeholder and preserves metadata", () => {
    const oldTools = Array.from({ length: 18 }, (_, index) =>
      tool({ id: `tool-${index}`, text: String(index).repeat(5_000) }),
    );
    const result = project(prunableHistory(oldTools), {
      config: {
        mode: "cache-ttl",
        hardClear: { placeholder: "[cleared by test]" },
      },
    });
    const first = result.find(
      (message) => message.role === "toolResult" && message.toolCallId === "tool-0",
    );
    expect(first).toMatchObject({
      toolCallId: "tool-0",
      toolName: "read",
      details: { source: "tool-0" },
      isError: false,
      timestamp: 42,
    });
    expect(toolText(result, "tool-0")).toBe("[cleared by test]");
  });
});
