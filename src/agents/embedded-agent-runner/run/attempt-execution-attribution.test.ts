import { describe, expect, it } from "vitest";
import { createAgentExecutionAttribution } from "../../agent-execution-attribution.js";
import {
  bindEmbeddedAttemptExecutionAttribution,
  resolveEmbeddedAttemptExecutionAttribution,
} from "./attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

describe("embedded attempt execution attribution", () => {
  it("keeps the host snapshot off the plugin-visible attempt object", () => {
    const attempt = { runId: "run-1" } as EmbeddedRunAttemptParams;
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });

    bindEmbeddedAttemptExecutionAttribution(attempt, attribution);

    expect(resolveEmbeddedAttemptExecutionAttribution(attempt)).toBe(attribution);
    expect(attempt).not.toHaveProperty("attribution");
    expect(JSON.stringify(attempt)).not.toContain("lifecycleGeneration");
  });

  it("leaves unattributed maintenance attempts unset", () => {
    const attempt = { runId: "maintenance" } as EmbeddedRunAttemptParams;

    bindEmbeddedAttemptExecutionAttribution(attempt, undefined);

    expect(resolveEmbeddedAttemptExecutionAttribution(attempt)).toBeUndefined();
  });
});
