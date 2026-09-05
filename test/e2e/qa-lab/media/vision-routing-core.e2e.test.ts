import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../../src/auto-reply/media-note.js";
import { resolveCurrentTurnImages } from "../../../../src/auto-reply/reply/current-turn-images.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ACTIVE_PROVIDER = "openai";
const ACTIVE_VISION_MODEL = "gpt-4.1";
const PRIMARY_PROVIDER = "qa-vision-primary";
const PRIMARY_MODEL = "primary-vision";
const FALLBACK_PROVIDER = "qa-vision-fallback";
const FALLBACK_MODEL = "fallback-vision";
const SUMMARY_TEXT = "QA_VISION_FALLBACK_SUMMARY";

const preparedVisionCatalog = vi.hoisted(() => [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
]);

vi.mock("../../../../src/agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: vi.fn(async () => preparedVisionCatalog),
}));

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

vi.mock("../../../../src/media-understanding/image-runtime.js", () => ({
  describeImageWithModel: vi.fn(),
  describeImagesWithModel: vi.fn(),
}));

function createImageContext(imagePath: string, workspaceDir: string): MsgContext {
  const body = "describe the attached image";
  return {
    Body: body,
    CommandBody: body,
    RawBody: body,
    media: [
      {
        path: imagePath,
        contentType: "image/png",
        kind: "image",
        workspaceDir,
      },
    ],
  };
}

function configuredProvider(model: string) {
  return {
    apiKey: "test-key", // pragma: allowlist secret
    baseUrl: "https://example.invalid/v1",
    models: [{ id: model, name: model, input: ["text", "image"] }],
  };
}

function imageDecision(ctx: MsgContext) {
  const decision = ctx.MediaUnderstandingDecisions?.find(
    (candidate) => candidate.capability === "image",
  );
  if (!decision) {
    throw new Error("expected an image media-understanding decision");
  }
  return decision;
}

function occurrenceCount(value: string | undefined, needle: string): number {
  if (value === undefined) {
    return 0;
  }
  return value.split(needle).length - 1;
}

describe("core vision routing product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("bypasses summarization and sends the real image to an active vision model", async () => {
    const workspaceDir = tempDirs.make("openclaw-vision-native-");
    const imagePath = path.join(workspaceDir, "native.png");
    const imageBytes = createSolidPngBuffer(2, 2, { r: 24, g: 96, b: 208 });
    await fs.writeFile(imagePath, imageBytes);
    const ctx = createImageContext(imagePath, workspaceDir);
    let summarizerCalls = 0;
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: `${FALLBACK_PROVIDER}/${FALLBACK_MODEL}`,
          },
        },
      },
      models: {
        providers: {
          [ACTIVE_PROVIDER]: configuredProvider(ACTIVE_VISION_MODEL),
          [FALLBACK_PROVIDER]: configuredProvider(FALLBACK_MODEL),
        },
      },
    } as unknown as OpenClawConfig;
    const providers = {
      [FALLBACK_PROVIDER]: {
        id: FALLBACK_PROVIDER,
        capabilities: ["image"],
        describeImage: async () => {
          summarizerCalls += 1;
          return { text: SUMMARY_TEXT, model: FALLBACK_MODEL };
        },
      } satisfies MediaUnderstandingProvider,
    };

    const applied = await applyMediaUnderstanding({
      ctx,
      cfg,
      agentId: "qa-vision-native",
      agentDir: workspaceDir,
      workspaceDir,
      providers,
      activeModel: { provider: ACTIVE_PROVIDER, model: ACTIVE_VISION_MODEL },
    });

    const decision = imageDecision(ctx);
    expect(decision.outcome).toBe("skipped");
    expect(decision.attachments).toEqual([
      {
        attachmentIndex: 0,
        attempts: [
          {
            type: "provider",
            provider: ACTIVE_PROVIDER,
            model: ACTIVE_VISION_MODEL,
            outcome: "skipped",
            reason: "primary model supports vision natively",
          },
        ],
        chosen: {
          type: "provider",
          provider: ACTIVE_PROVIDER,
          model: ACTIVE_VISION_MODEL,
          outcome: "skipped",
          reason: "primary model supports vision natively",
        },
      },
    ]);
    expect(applied.appliedImage).toBe(false);
    expect(applied.outputs).toHaveLength(0);
    expect(summarizerCalls).toBe(0);
    expect(ctx.Body).not.toContain(SUMMARY_TEXT);
    expect(ctx.Body).not.toContain("[Image]");

    const projection = buildInboundMediaNoteProjection(ctx);
    expect(projection.media[0]).not.toHaveProperty("hydrationSuppressed");

    const currentTurnImages = await resolveCurrentTurnImages({ ctx, cfg });
    expect(currentTurnImages).toEqual({
      images: [
        {
          type: "image",
          data: imageBytes.toString("base64"),
          mimeType: "image/png",
        },
      ],
      imageOrder: ["inline"],
    });
  });

  it("falls back in order, inserts one summary, and suppresses the described raw image", async () => {
    const workspaceDir = tempDirs.make("openclaw-vision-fallback-");
    const imagePath = path.join(workspaceDir, "fallback.png");
    await fs.writeFile(imagePath, createSolidPngBuffer(2, 2, { r: 208, g: 64, b: 24 }));
    const ctx = createImageContext(imagePath, workspaceDir);
    const providerCalls: string[] = [];
    const cfg = {
      tools: {
        media: {
          models: [
            {
              provider: PRIMARY_PROVIDER,
              model: PRIMARY_MODEL,
              capabilities: ["image"],
            },
            {
              provider: FALLBACK_PROVIDER,
              model: FALLBACK_MODEL,
              capabilities: ["image"],
            },
          ],
        },
      },
      models: {
        providers: {
          [PRIMARY_PROVIDER]: configuredProvider(PRIMARY_MODEL),
          [FALLBACK_PROVIDER]: configuredProvider(FALLBACK_MODEL),
        },
      },
    } as unknown as OpenClawConfig;
    const providers = {
      [PRIMARY_PROVIDER]: {
        id: PRIMARY_PROVIDER,
        capabilities: ["image"],
        describeImage: async () => {
          providerCalls.push(PRIMARY_PROVIDER);
          throw new Error("primary vision unavailable");
        },
      } satisfies MediaUnderstandingProvider,
      [FALLBACK_PROVIDER]: {
        id: FALLBACK_PROVIDER,
        capabilities: ["image"],
        describeImage: async (request) => {
          providerCalls.push(FALLBACK_PROVIDER);
          return { text: SUMMARY_TEXT, model: request.model };
        },
      } satisfies MediaUnderstandingProvider,
    };

    const applied = await applyMediaUnderstanding({
      ctx,
      cfg,
      agentId: "qa-vision-fallback",
      agentDir: workspaceDir,
      workspaceDir,
      providers,
    });

    const decision = imageDecision(ctx);
    expect(providerCalls).toEqual([PRIMARY_PROVIDER, FALLBACK_PROVIDER]);
    expect(decision.outcome).toBe("success");
    expect(decision.attachments[0]?.attempts).toEqual([
      expect.objectContaining({
        type: "provider",
        provider: PRIMARY_PROVIDER,
        model: PRIMARY_MODEL,
        outcome: "failed",
        reason: expect.stringContaining("primary vision unavailable"),
      }),
      {
        type: "provider",
        provider: FALLBACK_PROVIDER,
        model: FALLBACK_MODEL,
        outcome: "success",
      },
    ]);
    expect(decision.attachments[0]?.chosen).toEqual({
      type: "provider",
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
      outcome: "success",
    });
    expect(applied.outputs).toEqual([
      {
        kind: "image.description",
        attachmentIndex: 0,
        text: SUMMARY_TEXT,
        provider: FALLBACK_PROVIDER,
        model: FALLBACK_MODEL,
      },
    ]);
    expect(applied.appliedImage).toBe(true);
    expect(ctx.MediaUnderstanding).toEqual(applied.outputs);
    expect(occurrenceCount(ctx.Body, SUMMARY_TEXT)).toBe(1);

    const projection = buildInboundMediaNoteProjection(ctx);
    expect(projection.media).toEqual([
      expect.objectContaining({
        path: imagePath,
        contentType: "image/png",
        hydrationSuppressed: true,
      }),
    ]);
    await expect(resolveCurrentTurnImages({ ctx, cfg })).resolves.toEqual({});
  });
});
