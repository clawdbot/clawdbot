import { describe, expect, it } from "vitest";
import { normalizeEmbeddedAgentRuntime } from "../agent-runtime-id.js";
import * as embeddedAgentRunner from "../embedded-agent-runner.js";
import * as embeddedAgent from "../embedded-agent.js";

describe("embedded runner compatibility aliases", () => {
  it("keeps the embedded-agent barrel bound to the runner implementation", () => {
    expect(embeddedAgent.runEmbeddedAgent).toBe(embeddedAgentRunner.runEmbeddedAgent);
    expect(embeddedAgent.compactEmbeddedAgentSession).toBe(
      embeddedAgentRunner.compactEmbeddedAgentSession,
    );
    expect(embeddedAgent.abortEmbeddedAgentRun).toBe(embeddedAgentRunner.abortEmbeddedAgentRun);
  });

  it("normalizes shipped runtime aliases", () => {
    expect(normalizeEmbeddedAgentRuntime("pi")).toBe("openclaw");
    expect(normalizeEmbeddedAgentRuntime("codex-app-server")).toBe("codex");
  });

  it("does not rewrite custom runtime ids", () => {
    expect(normalizeEmbeddedAgentRuntime("custom-harness")).toBe("custom-harness");
  });
});
