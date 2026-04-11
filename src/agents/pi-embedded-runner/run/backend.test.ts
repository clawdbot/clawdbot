import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentHarnessFallback, resolveEmbeddedAgentRuntime } from "../runtime.js";

describe("resolveEmbeddedAgentRuntime", () => {
  it("uses auto mode by default", () => {
    expect(resolveEmbeddedAgentRuntime({})).toBe("auto");
  });

  it("accepts the PI kill switch", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "pi" })).toBe("pi");
  });

  it("preserves plugin harness ids without core-owned aliases", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex" })).toBe("codex");
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "codex-app-server" })).toBe(
      "codex-app-server",
    );
  });

  it("accepts auto mode", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "auto" })).toBe("auto");
  });

  it("preserves plugin harness runtime ids", () => {
    expect(resolveEmbeddedAgentRuntime({ OPENCLAW_AGENT_RUNTIME: "custom-harness" })).toBe(
      "custom-harness",
    );
  });
});

describe("resolveEmbeddedAgentHarnessFallback", () => {
  it("accepts the PI fallback kill switch", () => {
    expect(resolveEmbeddedAgentHarnessFallback({ OPENCLAW_AGENT_HARNESS_FALLBACK: "none" })).toBe(
      "none",
    );
    expect(resolveEmbeddedAgentHarnessFallback({ OPENCLAW_AGENT_HARNESS_FALLBACK: "pi" })).toBe(
      "pi",
    );
  });

  it("ignores unknown fallback values", () => {
    expect(
      resolveEmbeddedAgentHarnessFallback({ OPENCLAW_AGENT_HARNESS_FALLBACK: "custom" }),
    ).toBeUndefined();
  });
});
