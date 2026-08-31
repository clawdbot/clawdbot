import { describe, expect, it } from "vitest";
import { createReturnCovenantGatewayConfigSnapshot } from "./gateway-config.js";

describe("return-covenant gateway config", () => {
  it("migrates the accepted legacy runtime field in memory without changing source bytes", () => {
    const raw = {
      gateway: { mode: "local" },
      agents: {
        defaults: {
          model: "openai/gpt-5.6-luna",
          agentRuntime: { id: "codex" },
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
    };
    const original = structuredClone(raw);
    expect(
      createReturnCovenantGatewayConfigSnapshot({
        path: "/isolated/openclaw.json",
        raw,
      }).config,
    ).toMatchObject({
      gateway: { mode: "local" },
      agents: {
        defaults: { model: "openai/gpt-5.6-luna" },
        entries: { main: {} },
      },
      plugins: { entries: { codex: { enabled: true } } },
    });
    expect(raw).toEqual(original);
    expect(
      createReturnCovenantGatewayConfigSnapshot({
        path: "/isolated/openclaw.json",
        raw,
      }),
    ).toMatchObject({
      config: {
        gateway: { mode: "local" },
        agents: { entries: { main: {} } },
      },
      snapshot: {
        path: "/isolated/openclaw.json",
        exists: true,
        valid: true,
        issues: [],
        legacyIssues: [],
      },
    });
  });

  it("rejects config that remains invalid after canonical migration", () => {
    expect(() =>
      createReturnCovenantGatewayConfigSnapshot({
        path: "/isolated/openclaw.json",
        raw: { gateway: { mode: "invalid" } },
      }),
    ).toThrow(/gateway config is invalid/u);
  });
});
