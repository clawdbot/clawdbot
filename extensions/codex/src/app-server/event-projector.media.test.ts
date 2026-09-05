import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach } from "vitest";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  embeddedAgentLog,
  expect,
  it,
  vi,
  tinyPngBase64,
  fs,
  path,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

let openClawState: OpenClawTestState;
beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-codex-media-state-",
  });
});
afterEach(async () => {
  await openClawState.cleanup();
});

describe("CodexAppServerEventProjector media projection", () => {
  it("saves native Codex image-generation snapshots into gateway-managed media", async () => {
    const projector = await createProjector();
    const savedPath = "/home/dev-user/.codex/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).not.toBe(savedPath);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("saves typed Codex image-generation completions without a raw response or saved path", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_only",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("does not expose a remote saved path when typed image bytes are invalid", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_invalid",
          status: "completed",
          result: "not valid base64!",
          savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_typed_invalid.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("fetches saved-path-only remote images over the bounded Codex command protocol", async () => {
    const readRemoteWorkspaceFile = vi.fn(async () => ({ dataBase64: tinyPngBase64 }));
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
      readRemoteWorkspaceFile,
      remoteWorkspaceRequestTimeoutMs: 90_000,
    });
    const savedPath = "/remote/codex-home/generated_images/session-1/ig_saved_only.png";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_saved_only",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          savedPath,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(readRemoteWorkspaceFile).toHaveBeenCalledWith({
      path: savedPath,
      maxBytes: expect.any(Number),
      signal: undefined,
      timeoutMs: 90_000,
    });
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.toolMediaUrls?.[0]).not.toBe(savedPath);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it.each([false, true])(
    "fences direct tool-result callbacks after blocked media when projection closed=%s",
    async (closed) => {
      const media = createDeferred<{ dataBase64: string }>();
      const readRemoteWorkspaceFile = vi.fn(() => media.promise);
      const onToolResult = vi.fn();
      const projector = await createProjector(
        { ...(await createParams()), verboseLevel: "full", onToolResult },
        { remoteWorkspaceRoot: "/remote/workspace", readRemoteWorkspaceFile },
      );
      const pending = projector.handleNotification(
        turnCompleted([
          {
            type: "imageGeneration",
            id: "blocked-image",
            status: "completed",
            result: "",
            revisedPrompt: null,
            savedPath: "/remote/workspace/image.png",
          },
          {
            type: "commandExecution",
            id: "command-after-image",
            command: "echo late-output",
            cwd: "/remote/workspace",
            commandActions: [],
            processId: null,
            source: "agent",
            status: "completed",
            aggregatedOutput: "late-output",
            exitCode: 0,
            durationMs: 1,
          },
        ]),
      );
      try {
        await vi.waitFor(() => expect(readRemoteWorkspaceFile).toHaveBeenCalledOnce());
        expect(onToolResult).not.toHaveBeenCalled();
        if (closed) {
          await projector.closeProjection();
        }
        media.resolve({ dataBase64: tinyPngBase64 });
        await pending;
        if (closed) {
          expect(onToolResult).not.toHaveBeenCalled();
        } else {
          expect(onToolResult).toHaveBeenCalledWith(
            expect.objectContaining({ text: expect.stringContaining("late-output") }),
          );
        }
      } finally {
        media.resolve({ dataBase64: tinyPngBase64 });
        await pending;
      }
    },
  );

  it("never exposes a remote image path when remote file transfer is unavailable", async () => {
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_remote_unavailable",
          status: "completed",
          savedPath: "/remote/codex-home/generated_images/session-1/ig_remote_unavailable.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("preserves image side-effect state when remote file transfer fails", async () => {
    const readRemoteWorkspaceFile = vi.fn(async () => {
      throw new Error("remote generated image is unavailable");
    });
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
      readRemoteWorkspaceFile,
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_remote_transfer_failed",
          status: "completed",
          savedPath: "/remote/codex-home/generated_images/session-1/ig_transfer_failed.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(readRemoteWorkspaceFile).toHaveBeenCalledOnce();
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("saves raw Codex image-generation results as reply media", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_raw_1",
          status: "generating",
          result: tinyPngBase64,
          revised_prompt: "A tiny blue square",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    expect(mediaUrl?.endsWith(".png")).toBe(true);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("does not let delayed raw completion consume a newer assistant echo", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "answer-a", text: "rewritten A" },
      }),
    );

    const rawAnswerA = projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "answer-a",
          role: "assistant",
          content: [{ type: "output_text", text: "original A" }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "answer-b", text: "rewritten B" },
      }),
    );
    await rawAnswerA;
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "answer-b",
          role: "assistant",
          content: [{ type: "output_text", text: "original B" }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["rewritten B"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "rewritten B" }]);
  });

  it("keeps raw image-generation results replay-invalid when media save fails", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_raw_capped",
          status: "completed",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server raw image generation result exceeds media limit",
      expect.objectContaining({ itemId: "ig_raw_capped" }),
    );
  });

  it("rejects oversized typed Codex images instead of using a remote saved path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_capped",
          status: "completed",
          result: tinyPngBase64,
          savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_typed_capped.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server native image generation result exceeds media limit",
      expect.objectContaining({ itemId: "ig_typed_capped" }),
    );
  });

  it("dedupes raw and typed Codex image-generation media for the same item", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_123",
          status: "generating",
          result: tinyPngBase64,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.toolMediaUrls?.[0]).not.toBe(savedPath);
  });

  it("materializes overlapping typed and raw image events only once", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "imageGeneration",
            id: "ig_concurrent",
            status: "completed",
            revisedPrompt: "A tiny blue square",
            result: tinyPngBase64,
            savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_concurrent.png",
          },
        }),
      ),
      projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id: "ig_concurrent",
            status: "completed",
            result: tinyPngBase64,
          },
        }),
      ),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    await expect(fs.readdir(path.dirname(mediaUrl ?? ""))).resolves.toHaveLength(1);
  });

  it("retries valid typed image bytes after an overlapping invalid raw event", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id: "ig_retry_valid",
            status: "completed",
            result: "not valid base64!",
          },
        }),
      ),
      projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "imageGeneration",
            id: "ig_retry_valid",
            status: "completed",
            result: tinyPngBase64,
            savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_retry_valid.png",
          },
        }),
      ),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toHaveLength(1);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("prefers gateway-managed image media when the typed event arrives first", async () => {
    const projector = await createProjector();
    const savedPath = "/home/dev-user/.codex/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_123",
          status: "generating",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(mediaUrl).not.toBe(savedPath);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("preserves distinct raw image-generation items with identical image bytes", async () => {
    const projector = await createProjector();

    for (const id of ["ig_raw_1", "ig_raw_2"]) {
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id,
            status: "generating",
            result: tinyPngBase64,
          },
        }),
      );
    }

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toHaveLength(2);
    expect(new Set(result.toolMediaUrls)).toHaveLength(2);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
  });

  it("does not append native Codex image-generation media after explicit media delivery", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: null,
          result: "Zm9v",
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      messagingToolSentMediaUrls: [savedPath],
      toolMediaUrls: [],
    });

    expect(result.toolMediaUrls).toStrictEqual([]);
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });

  it("propagates source reply delivery without destination telemetry", async () => {
    const projector = await createProjector();

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      sourceReplyDelivered: true,
    });

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.sourceReplyDelivered).toBe(true);
  });
});
