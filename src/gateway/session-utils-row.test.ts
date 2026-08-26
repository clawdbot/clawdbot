// Gateway session row tests cover projected effective session settings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

describe("buildGatewaySessionRow", () => {
  it("projects inherited reasoning defaults separately from the stored override", () => {
    const row = buildGatewaySessionRow({
      cfg: {
        agents: {
          defaults: { reasoningDefault: "stream" },
        },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-main",
        updatedAt: 1,
      },
      now: 1,
      lightweightListRow: true,
    });

    expect(row.reasoningLevel).toBeUndefined();
    expect(row.effectiveReasoningLevel).toBe("stream");
  });

  it("projects the prepared model reasoning default when no override exists", () => {
    const row = buildGatewaySessionRow({
      cfg: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-8" } },
        },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-main",
        updatedAt: 1,
      },
      modelCatalog: [
        {
          provider: "anthropic",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
        },
      ],
      now: 1,
      lightweightListRow: true,
    });

    expect(row.reasoningLevel).toBeUndefined();
    expect(row.effectiveReasoningLevel).toBe("on");
  });

  it("omits an unknown model reasoning default without a catalog", () => {
    const row = buildGatewaySessionRow({
      cfg: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-8" } },
        },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-main",
        updatedAt: 1,
      },
      now: 1,
      lightweightListRow: true,
    });

    expect(row.reasoningLevel).toBeUndefined();
    expect(row).not.toHaveProperty("effectiveReasoningLevel");
  });

  it("keeps per-model thinking defaults from enabling model reasoning defaults", () => {
    const row = buildGatewaySessionRow({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-reasoning" },
            models: { "openai/gpt-reasoning": { params: { thinking: "off" } } },
          },
        },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-main",
        updatedAt: 1,
      },
      modelCatalog: [
        { provider: "openai", id: "gpt-reasoning", name: "GPT Reasoning", reasoning: true },
      ],
      now: 1,
      lightweightListRow: true,
    });

    expect(row.reasoningLevel).toBeUndefined();
    expect(row.effectiveReasoningLevel).toBe("off");
  });

  it("preserves legacy stored non-off reasoning values in the effective projection", () => {
    const row = buildGatewaySessionRow({
      cfg: {
        agents: {
          defaults: { reasoningDefault: "off" },
        },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-main",
        updatedAt: 1,
        reasoningLevel: "high",
      },
      now: 1,
      lightweightListRow: true,
    });

    expect(row.reasoningLevel).toBe("high");
    expect(row.effectiveReasoningLevel).toBe("high");
  });
});
