/**
 * Agent-session token estimation mock.
 *
 * Tests import this before session modules to replace token estimation with a
 * deterministic text-length approximation.
 */
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
    // Approximate one token per four characters while preserving a non-zero
    // token count for empty messages that still participate in budgets.
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
