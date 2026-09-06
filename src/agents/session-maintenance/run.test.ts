import { expect, it } from "vitest";
import { buildEmbeddedRunBaseParams } from "../../auto-reply/reply/agent-runner-run-params.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { createSessionMaintenanceFollowup } from "./run.js";

it("carries restrictive conversation policy into maintenance without foreground authority", async () => {
  const foreground = createTestFollowupRun({
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  foreground.run.config = {
    models: {
      providers: {
        "test-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          models: [
            {
              id: "test-model",
              name: "Fixture",
              input: ["text"],
              reasoning: false,
              maxTokens: 1_024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  const maintenance = createSessionMaintenanceFollowup({
    run: foreground.run,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: foreground.run.config,
    provider: "test-provider",
    model: "test-model",
    auth: {},
  });
  const embedded = await buildEmbeddedRunBaseParams({
    run: maintenance.run,
    provider: "test-provider",
    model: "test-model",
    runId: "maintenance-run",
    authProfile: {},
  });
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
});
