import { vi } from "vitest";

const piCodingAgentTokenMocks = vi.hoisted(() => {
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

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentTokenMocks.estimateTokens,
  };
});
