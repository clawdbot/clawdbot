import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  detectAndLoadPromptImages: vi.fn(),
  resolveImageSanitizationLimits: vi.fn(() => ({ maxDimensionPx: 2048 })),
}));

vi.mock("@openclaw/media-core/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/media-core/constants")>()),
  MAX_IMAGE_BYTES: 1_234,
  mediaKindFromMime: (mime?: string) =>
    mime ? (mime.startsWith("image/") ? "image" : "unknown") : undefined,
}));
vi.mock("../../image-sanitization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../image-sanitization.js")>()),
  resolveImageSanitizationLimits: hoisted.resolveImageSanitizationLimits,
}));
vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: hoisted.detectAndLoadPromptImages,
}));

import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

type PromptExecutionInput = Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0];

function createInput(overrides: Partial<PromptExecutionInput> = {}): PromptExecutionInput {
  return {
    attempt: {
      config: { agents: { defaults: { imageMaxDimensionPx: 2048 } } },
      imageOrder: ["inline"],
      images: [{ type: "image", data: "data", mimeType: "image/png" }],
      model: {
        api: "google-generative-ai",
        id: "model-1",
        input: ["text", "image"],
        provider: "provider-1",
      },
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
    },
    effectiveFsWorkspaceOnly: true,
    effectiveWorkspace: "/tmp/workspace",
    prompt: "inspect image.png",
    sandbox: {
      enabled: true,
      fsBridge: { readFile: vi.fn() },
      workspaceDir: "/sandbox/workspace",
    },
    skipPromptSubmission: false,
    ...overrides,
  } as PromptExecutionInput;
}

describe("prepareEmbeddedAttemptPromptExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveImageSanitizationLimits.mockReturnValue({ maxDimensionPx: 2048 });
    hoisted.detectAndLoadPromptImages.mockResolvedValue({
      images: [{ type: "image", data: "loaded", mimeType: "image/png" }],
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    });
  });

  it("returns an isolated empty image result when prompt submission is already skipped", async () => {
    const first = await prepareEmbeddedAttemptPromptExecution(
      createInput({ skipPromptSubmission: true }),
    );
    first.images.push({ type: "image", data: "mutated", mimeType: "image/png" });
    const second = await prepareEmbeddedAttemptPromptExecution(
      createInput({ skipPromptSubmission: true }),
    );

    expect(second).toEqual({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 0,
      skippedCount: 0,
    });
    expect(hoisted.detectAndLoadPromptImages).not.toHaveBeenCalled();
  });

  it("loads prompt images with the prepared workspace policy", async () => {
    const input = createInput();

    const result = await prepareEmbeddedAttemptPromptExecution(input);

    expect(hoisted.detectAndLoadPromptImages).toHaveBeenCalledWith({
      prompt: "inspect image.png",
      workspaceDir: "/tmp/workspace",
      model: input.attempt.model,
      existingImages: input.attempt.images,
      imageOrder: ["inline"],
      maxBytes: 1_234,
      maxDimensionPx: 2048,
      workspaceOnly: true,
      sandbox: {
        root: "/sandbox/workspace",
        bridge: input.sandbox?.fsBridge,
      },
    });
    expect(result).toEqual({
      images: [{ type: "image", data: "loaded", mimeType: "image/png" }],
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    });
  });

  it("omits sandbox constraints when no sandbox bridge is active", async () => {
    const input = createInput({ sandbox: null });

    await prepareEmbeddedAttemptPromptExecution(input);

    expect(hoisted.detectAndLoadPromptImages).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: undefined }),
    );
  });

  it("reports failed hydration without consuming the embedded attempt fact", async () => {
    const base = createInput();
    const media = [{ path: "/tmp/missing.png", contentType: "image/png" }];
    const input = createInput({ attempt: { ...base.attempt, media } });
    hoisted.detectAndLoadPromptImages.mockResolvedValueOnce({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 1,
      loadedCount: 0,
      skippedCount: 1,
    });

    const result = await prepareEmbeddedAttemptPromptExecution(input);

    expect(result.failedMediaCount).toBe(1);
    expect(input.attempt.media).toBe(media);
  });

  it.each([
    {
      name: "facts-only",
      message: { __openclaw: { media: [{ path: "/tmp/fact.png", contentType: "image/png" }] } },
      expectedPath: "/tmp/fact.png",
    },
    {
      name: "both-equal",
      message: {
        MediaPath: "/tmp/equal.png",
        __openclaw: { media: [{ path: "/tmp/equal.png", contentType: "image/png" }] },
      },
      expectedPath: "/tmp/equal.png",
    },
    {
      name: "both-conflict",
      message: {
        MediaPath: "/tmp/legacy-conflict.png",
        __openclaw: { media: [{ path: "/tmp/canonical.png", contentType: "image/png" }] },
      },
      expectedPath: "/tmp/canonical.png",
    },
    {
      name: "sparse",
      message: {
        __openclaw: { media: [{}, { path: "/tmp/sparse.png", contentType: "image/png" }] },
      },
      expectedPath: "/tmp/sparse.png",
      expectedIndex: 1,
    },
    {
      name: "type-only",
      message: { __openclaw: { media: [{ contentType: "image/png" }] } },
      expectedPath: undefined,
    },
    {
      name: "media-only",
      message: {
        role: "user",
        content: "",
        __openclaw: { media: [{ path: "/tmp/media-only.png", kind: "image" }] },
      },
      expectedPath: "/tmp/media-only.png",
    },
  ])("hydrates $name persisted rows through canonical media", async (testCase) => {
    const base = createInput();
    const persistedMessage = {
      role: "user" as const,
      content: "inspect",
      ...testCase.message,
    };
    const input = createInput({
      attempt: {
        ...base.attempt,
        userTurnTranscriptRecorder: {
          message: persistedMessage,
          resolveMessage: vi.fn(async () => persistedMessage),
        } as unknown as NonNullable<PromptExecutionInput["attempt"]["userTurnTranscriptRecorder"]>,
      },
    });

    await prepareEmbeddedAttemptPromptExecution(input);

    const call = hoisted.detectAndLoadPromptImages.mock.calls.at(-1)?.[0];
    const expectedIndex = "expectedIndex" in testCase ? (testCase.expectedIndex ?? 0) : 0;
    expect(call?.media?.[expectedIndex]?.path).toBe(testCase.expectedPath);
  });

  it("uses persisted facts and layout as the current-turn provenance authority", async () => {
    const base = createInput();
    const persistedMessage = {
      role: "user" as const,
      content: "compare",
      MediaPaths: ["/tmp/legacy-inline.png", "/tmp/legacy-offloaded.png"],
      MediaTypes: ["image/png", "image/png"],
      __openclaw: {
        media: [
          {
            path: "/tmp/inline.png",
            contentType: "image/png",
            hydrationSuppressed: true,
          },
          { path: "/tmp/offloaded.png", contentType: "image/png" },
        ],
        mediaImageLayout: {
          slots: [
            { kind: "inline", factIndex: 0 },
            { kind: "offloaded", factIndex: 1 },
          ],
        },
      },
    };
    const input = createInput({
      attempt: {
        ...base.attempt,
        media: [{ path: "/tmp/offloaded.png", contentType: "image/png" }],
        userTurnTranscriptRecorder: {
          message: persistedMessage,
          resolveMessage: vi.fn(async () => persistedMessage),
        } as unknown as NonNullable<PromptExecutionInput["attempt"]["userTurnTranscriptRecorder"]>,
      },
    });

    await prepareEmbeddedAttemptPromptExecution(input);

    expect(hoisted.detectAndLoadPromptImages).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({
            path: "/tmp/inline.png",
            kind: "image",
            hydrationSuppressed: true,
          }),
          expect.objectContaining({ path: "/tmp/offloaded.png", kind: "image" }),
        ],
        mediaImageLayout: {
          slots: [
            { kind: "inline", factIndex: 0 },
            { kind: "offloaded", factIndex: 1 },
          ],
          suppressedFactIndexes: [],
        },
      }),
    );
  });
});
