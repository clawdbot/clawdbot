import { describe, expect, it } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  createAgentExecutionAttribution,
  rebindAgentExecutionAttribution,
} from "./agent-execution-attribution.js";

describe("createAgentExecutionAttribution", () => {
  it("preserves required identities, normalizes optional correlation, and freezes the record", () => {
    const token = createExecutionIdentityAdmissionToken(" run-1 ", {
      contextId: "context-1",
      executionId: "execution-1",
      now: 123,
    });
    const attribution = createAgentExecutionAttribution({
      runId: " run-1 ",
      lifecycleGeneration: " generation-1 ",
      sessionKey: " agent:main:main ",
      sessionId: " session-1 ",
      agentId: " main ",
      executionIdentityAdmission: { token, retryOnly: true },
    });

    expect(attribution).toEqual({
      runId: " run-1 ",
      contextId: "context-1",
      executionId: "execution-1",
      createdAt: 123,
      lifecycleGeneration: " generation-1 ",
      executionIdentityAdmission: { token, retryOnly: true },
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
    });
    expect(Object.isFrozen(attribution)).toBe(true);
    expect(Reflect.set(attribution, "sessionId", "replacement")).toBe(false);
  });

  it("leaves unknown optional correlation absent", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
      sessionKey: " ",
      sessionId: "",
    });
    expect(attribution).toMatchObject({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    expect(attribution).not.toHaveProperty("sessionKey");
    expect(attribution).not.toHaveProperty("sessionId");
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
    expect(attribution.contextId).toBeTruthy();
    expect(attribution.executionId).toBeTruthy();
    expect(attribution.createdAt).toBeGreaterThan(0);
  });

  it("does not apply the opt-in audit token bounds to default runtime attribution", () => {
    const runId = "r".repeat(1_024);
    const attribution = createAgentExecutionAttribution({
      runId,
      lifecycleGeneration: "generation-1",
    });

    expect(attribution.runId).toBe(runId);
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it.each([false, true])(
    "changes only lifecycle ownership when rebound (token=%s)",
    (withToken) => {
      const runId = "run-rebound";
      const attribution = createAgentExecutionAttribution({
        runId,
        lifecycleGeneration: "generation-1",
        ...(withToken
          ? {
              executionIdentityAdmission: {
                token: createExecutionIdentityAdmissionToken(runId, {
                  contextId: "context-1",
                  executionId: "execution-1",
                  now: 123,
                }),
                retryOnly: true,
              },
            }
          : {}),
      });

      const rebound = rebindAgentExecutionAttribution(attribution, "generation-2");

      expect(rebound).toEqual({
        ...attribution,
        lifecycleGeneration: "generation-2",
      });
      expect(rebound.contextId).toBe(attribution.contextId);
      expect(rebound.executionId).toBe(attribution.executionId);
      expect(rebound.createdAt).toBe(attribution.createdAt);
      expect(rebound.executionIdentityAdmission).toBe(attribution.executionIdentityAdmission);
      expect(Object.isFrozen(rebound)).toBe(true);
    },
  );

  it.each([
    ["runId", { runId: " ", lifecycleGeneration: "generation-1" }],
    ["lifecycleGeneration", { runId: "run-1", lifecycleGeneration: "" }],
  ])("rejects a missing required %s", (field, params) => {
    expect(() => createAgentExecutionAttribution(params)).toThrow(
      `Agent execution attribution requires ${field}`,
    );
  });

  it("rejects an admission token owned by another run", () => {
    expect(() =>
      createAgentExecutionAttribution({
        runId: "run-1",
        lifecycleGeneration: "generation-1",
        executionIdentityAdmission: {
          token: createExecutionIdentityAdmissionToken("run-2"),
          retryOnly: false,
        },
      }),
    ).toThrow("Agent execution attribution token disagrees with runId");
  });
});
