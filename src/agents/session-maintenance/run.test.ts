import { expect, it } from "vitest";
import { buildEmbeddedRunBaseParams } from "../../auto-reply/reply/agent-runner-run-params.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { createSessionMaintenanceFollowup } from "./run.js";

it("preserves prepared model facts and restrictive policy without foreground authority", async () => {
  const foreground = createTestFollowupRun({
    provider: "test-provider",
    model: "test-model",
    thinkingCatalog: [{ provider: "test-provider", id: "test-model", input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
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
    isReasoningTagProvider: () => {
      throw new Error("Prepared runtime hints must not be rediscovered");
    },
  });
  expect(embedded.modelHasVision).toBe(true);
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
});
