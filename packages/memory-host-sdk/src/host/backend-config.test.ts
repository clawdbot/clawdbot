import { describe, expect, it } from "vitest";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("uses the builtin backend with automatic citations by default", () => {
    expect(resolveMemoryBackendConfig({ cfg: {}, agentId: "main" })).toEqual({
      backend: "builtin",
      citations: "auto",
    });
  });

  it("preserves the configured citation mode", () => {
    expect(
      resolveMemoryBackendConfig({
        cfg: { memory: { citations: "off" } },
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin", citations: "off" });
  });
});
