import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  embeddedAgentLog,
  withTempDir,
  expect,
  it,
  vi,
  tinyPngBase64,
  fs,
  os,
  path,
  trackTempDir,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector media projection", () => {
  it("attaches native Codex image-generation saved paths as reply media", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: "Zm9v",
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toEqual([savedPath]);
    expect(result.hostOwnedToolMediaUrls).toEqual([savedPath]);
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("saves raw Codex image-generation results as reply media", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-media-state-"));
    trackTempDir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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

  it("supersedes terminal assistant text before raw image persistence settles", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "answer-before-image", text: "stale answer" },
      }),
    );
    expect(projector.hasLatestTerminalAssistantCandidateText()).toBe(true);

    let resolveMedia: (() => void) | undefined;
    const mediaPersistence = new Promise<void>((resolve) => {
      resolveMedia = resolve;
    });
    const mediaProjection = (
      projector as unknown as {
        generatedMediaProjection: { recordRaw(item: unknown): Promise<void> };
      }
    ).generatedMediaProjection;
    vi.spyOn(mediaProjection, "recordRaw").mockReturnValue(mediaPersistence);

    const pending = projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "image-after-answer",
          status: "completed",
          result: tinyPngBase64,
        },
      }),
    );

    expect(projector.hasLatestTerminalAssistantCandidateText()).toBe(false);
    resolveMedia?.();
    await pending;
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

  it("dedupes raw and typed Codex image-generation media for the same item", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-media-state-"));
    trackTempDir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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

  it("prefers gateway-managed image media when the typed event arrives first", async () => {
    await withTempDir("openclaw-codex-media-state-", async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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
  });

  it("preserves distinct raw image-generation items with identical image bytes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-media-state-"));
    trackTempDir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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

  it("propagates message-tool-only source reply delivery telemetry", async () => {
    const projector = await createProjector();

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
    });

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
  });
});
