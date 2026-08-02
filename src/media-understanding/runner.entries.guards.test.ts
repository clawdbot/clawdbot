// Runner entry guard tests cover malformed decision data formatting without
// depending on provider execution.
import { afterEach, describe, expect, it } from "vitest";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "../secrets/runtime-media-secret-owner.js";
import { buildModelDecision, formatDecisionSummary, runProviderEntry } from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("media-understanding formatDecisionSummary guards", () => {
  it("formats skipped summary when decision.attachments is undefined", () => {
    expect(
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
      }),
    ).toBe("image: skipped");
  });

  it("counts malformed attachment attempts as unchosen", () => {
    expect(
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("video: skipped (0/1)");
  });

  it("ignores non-string provider/model/reason fields", () => {
    expect(
      formatDecisionSummary({
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            chosen: {
              outcome: "failed",
              provider: { bad: true },
              model: 42,
            },
            attempts: [{ reason: { malformed: true } }],
          },
        ],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("audio: failed (0/1)");
  });
});

describe("media-understanding CLI backend decisions", () => {
  it.each([
    {
      command: "sherpa-onnx-offline",
      args: ["--provider=cuda", "{{MediaPath}}"],
      requestedBackend: "cuda",
    },
    {
      command: "sherpa-onnx-offline",
      args: ["{{MediaPath}}"],
      requestedBackend: "cpu",
    },
    {
      command: "whisper-cli",
      args: ["--no-gpu", "{{MediaPath}}"],
      requestedBackend: "cpu",
    },
    {
      command: "whisper-cli",
      args: ["--device", "GPU0", "{{MediaPath}}"],
      requestedBackend: "device:GPU0",
    },
  ])(
    "reports $command backend request as $requestedBackend",
    ({ command, args, requestedBackend }) => {
      expect(
        buildModelDecision({
          entry: { type: "cli", command, args },
          entryType: "cli",
          outcome: "success",
        }),
      ).toMatchObject({ provider: command, model: command, requestedBackend });
    },
  );
});

async function getMissingProviderError(provider: string): Promise<string> {
  type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
  const error = await runProviderEntry({
    capability: "audio",
    entry: { provider },
    cfg: {},
    ctx: {} as RunProviderEntryParams["ctx"],
    attachmentIndex: 0,
    cache: {} as RunProviderEntryParams["cache"],
    providerRegistry: new Map(),
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) {
    throw new Error("expected missing media provider error");
  }
  return error.message;
}

describe("media-understanding missing provider errors", () => {
  it("includes the catalog repair hint for a media provider contract", async () => {
    const message = await getMissingProviderError("groq");
    expect(message).toMatch(/^Media provider not available: groq .*openclaw plugins install/);
    expect(message).toContain("@openclaw/groq-provider");
    expect(message).toContain("openclaw plugins registry --refresh");
    expect(message).toContain("stop and start the gateway service");
    expect(message).toContain("openclaw doctor --fix");
  });

  it.each(["amazon-bedrock", "mystery-provider", "feishu"])(
    "keeps the legacy error for provider without a media contract: %s",
    async (provider) => {
      await expect(getMissingProviderError(provider)).resolves.toBe(
        `Media provider not available: ${provider}`,
      );
    },
  );
});

describe("media-understanding SecretRef owner isolation", () => {
  it("rejects only the configured media model whose owner is unavailable", async () => {
    const entry = { provider: "openai", capabilities: ["audio" as const] };
    const cfg = { tools: { media: { models: [entry], audio: {} } } };
    const ownerId = runtimeMediaModelSecretOwnerId({
      source: "shared",
      index: 0,
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId,
        state: "unavailable",
        paths: ["tools.media.models.0.request.auth.token"],
        refKeys: ["env:default:MISSING_MEDIA_VALUE"],
        reason: "secret reference was not found",
      },
    ]);

    type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
    await expect(
      runProviderEntry({
        capability: "audio",
        entry,
        cfg,
        config: cfg.tools.media.audio,
        secretOwnerId: ownerId,
        ctx: {} as RunProviderEntryParams["ctx"],
        attachmentIndex: 0,
        cache: {} as RunProviderEntryParams["cache"],
        providerRegistry: new Map(),
      }),
    ).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId,
    });
  });

  it("keeps a model active when it overrides the unavailable request field", async () => {
    const entry = {
      provider: "unknown-provider",
      capabilities: ["audio" as const],
      request: { auth: { mode: "authorization-bearer" as const, token: "test-token" } },
    };
    const cfg = { tools: { media: { models: [entry], audio: {} } } };
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMediaRequestSecretOwnerId("audio"),
        state: "unavailable",
        paths: ["tools.media.audio.request.auth.token"],
        refKeys: ["env:default:MISSING_MEDIA_DEFAULT_VALUE"],
        reason: "secret reference was not found",
      },
    ]);

    type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
    await expect(
      runProviderEntry({
        capability: "audio",
        entry,
        cfg,
        config: cfg.tools.media.audio,
        ctx: {} as RunProviderEntryParams["ctx"],
        attachmentIndex: 0,
        cache: {} as RunProviderEntryParams["cache"],
        providerRegistry: new Map(),
      }),
    ).rejects.toThrow("Media provider not available: unknown-provider");
  });
});
