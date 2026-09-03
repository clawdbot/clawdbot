// Codex tests cover frozen workspace policy across physical thread replacement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

describe("Codex app-server rotated workspace policy", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it("keeps the established hierarchy frozen when lifecycle policy rotates", async () => {
    const workspaceDir = "/tmp/openclaw-codex-rotated-workspace-policy";
    const capturedRootGuidance = "Keep the original root instructions for this session.";
    const capturedNestedGuidance = "Keep the original nested instructions for this session.";
    const replacementGuidance = "Changed B instructions belong only to a new session.";
    const capturedGuidance = `${capturedRootGuidance}\n${capturedNestedGuidance}`;
    const developerInstructions = `Frozen Codex Project Instructions\n${capturedGuidance}`;
    const attempt = createParams("/tmp/openclaw-codex-rotated-policy.jsonl", workspaceDir);
    let startCount = 0;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        startCount += 1;
        return threadStartResult(`thread-${startCount}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTool = (name: string) => ({
      type: "function" as const,
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    });
    const common = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [dynamicTool("workspace-tool-a")],
      developerInstructions,
      coldDeveloperInstructions: developerInstructions,
      agentWorkspaceDeveloperInstructions: capturedGuidance,
      agentWorkspaceDeveloperInstructionsAllowed: true,
      config: { project_doc_max_bytes: 64_000 },
      appServer: createAppServerOptions(),
    };

    await startOrResumeThread(common);
    const replacement = await startOrResumeThread({
      ...common,
      dynamicTools: [dynamicTool("workspace-tool-b")],
      developerInstructions: `Frozen Codex Project Instructions\n${replacementGuidance}`,
      nativeProjectDocsDisabledOnResume: true,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
    const replacementRequest = request.mock.calls[1]?.[1] as
      | { config?: { project_doc_max_bytes?: number }; developerInstructions?: string }
      | undefined;
    expect(replacementRequest?.config?.project_doc_max_bytes).toBe(0);
    expect(replacementRequest?.developerInstructions).toContain(capturedRootGuidance);
    expect(replacementRequest?.developerInstructions).toContain(capturedNestedGuidance);
    expect(replacementRequest?.developerInstructions).not.toContain(replacementGuidance);
    expect(replacement).toMatchObject({
      threadId: "thread-2",
      agentWorkspaceDeveloperInstructions: capturedGuidance,
    });
    expect(
      testCodexAppServerBindingStore.read(
        sessionBindingIdentity({
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          agentId: attempt.agentId,
          config: attempt.config,
        }),
      ),
    ).toMatchObject({
      threadId: "thread-2",
      agentWorkspaceDeveloperInstructions: capturedGuidance,
    });
  });
});
