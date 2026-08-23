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
