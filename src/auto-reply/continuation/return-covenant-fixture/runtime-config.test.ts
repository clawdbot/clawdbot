import { describe, expect, it } from "vitest";
import { projectReturnCovenantRuntimeConfig } from "./runtime-config.js";

describe("return-covenant runtime config projection", () => {
  it("accepts the attested harness config without taking ownership of runtime fields", () => {
    expect(
      projectReturnCovenantRuntimeConfig({
        gateway: { mode: "local" },
        agents: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            agentRuntime: { id: "codex" },
          },
        },
        plugins: { entries: { codex: { enabled: true } } },
      }),
    ).toEqual({
      gateway: { mode: "local" },
      agents: { defaults: { model: "openai/gpt-5.6-luna" } },
    });
  });

  it("rejects a non-local gateway or invalid explicit port", () => {
    expect(() =>
      projectReturnCovenantRuntimeConfig({
        gateway: { mode: "remote" },
      }),
    ).toThrow(/valid local gateway config/u);
    expect(() =>
      projectReturnCovenantRuntimeConfig({
        gateway: { mode: "local", port: 0 },
      }),
    ).toThrow(/valid local gateway config/u);
  });
});
