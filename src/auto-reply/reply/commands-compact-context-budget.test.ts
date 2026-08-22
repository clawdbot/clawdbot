// Tests compact command context-budget resolution separately from command lifecycle behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn(),
  compactEmbeddedAgentSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isCurrentSessionEntry: vi.fn(() => true),
  isEmbeddedAgentRunAbortableForCompaction: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

const {
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  incrementCompactionCount,
  isCurrentSessionEntry,
} = await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

function buildCompactParams(cfg: OpenClawConfig): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: "/compact",
      commandText: "/compact",
    },
    command: {
      commandBodyNormalized: "/compact",
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
  } as unknown as HandleCommandsParams;
}

function requireCompactEmbeddedAgentSessionCall() {
  const call = vi.mocked(compactEmbeddedAgentSession).mock.calls[0]?.[0];
  if (!call) {
    throw new Error("compactEmbeddedAgentSession call missing");
  }
  return call;
}

describe("handleCompactCommand context budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementCompactionCount).mockResolvedValue(1);
    vi.mocked(isCurrentSessionEntry).mockReturnValue(true);
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("resolves the active Codex runtime config instead of stale session metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams({
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5", contextWindow: 258_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig),
        provider: "openai",
        model: "openai/gpt-5.5",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "live-session",
          updatedAt: Date.now(),
          contextTokens: 400_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(258_000);
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  });

  it("retains persisted context when an unknown custom model uses a legacy alias", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already compacted",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams({
          agents: {
            defaults: {
              models: { "custom/actual-model": { alias: "legacy-fast-model" } },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        provider: "custom",
        model: "actual-model",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "legacy-model-session",
          updatedAt: Date.now(),
          providerOverride: "custom",
          modelOverride: "legacy-fast-model",
          modelOverrideSource: "user",
          contextTokens: 777_777,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(777_777);
  });
});
