import { describe, expect, it, vi } from "vitest";

const runtimeSchema = vi.hoisted(() => ({
  load: vi.fn(() => {
    throw new Error("invalid runtime config");
  }),
}));

vi.mock("../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: runtimeSchema.load,
}));

import { redactSystemAgentConfig } from "./config-redaction.js";

describe("redactSystemAgentConfig", () => {
  it("fails closed for dynamic plugin secrets when runtime config is invalid", () => {
    expect(
      redactSystemAgentConfig({
        plugins: { entries: { custom: { config: { opaque: "plugin-secret" } } } },
      }),
    ).toEqual({ plugins: { entries: { custom: { config: "<redacted>" } } } });
  });
});
