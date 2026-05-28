import { vi } from "vitest";

const agentSessionTokenMocks = vi.hoisted(() => {
  function readText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(readText).join("");
    }
    if (value && typeof value === "object") {
      const record = value as { text?: unknown; content?: unknown; arguments?: unknown };
      return `${readText(record.text)}${readText(record.content)}${readText(record.arguments)}`;
    }
    return "";
  }

  function estimateTokenish(message: unknown): number {
    return Math.max(1, Math.ceil(readText(message).length / 4));
  }

  return {
    estimateTokens: vi.fn((message: unknown) => estimateTokenish(message)),
  };
});

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions/index.js")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    estimateTokens: agentSessionTokenMocks.estimateTokens,
  };
});
