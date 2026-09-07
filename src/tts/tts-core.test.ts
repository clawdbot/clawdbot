import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { AssistantMessage, Model, Usage } from "../llm/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { resolveSpeechProviderApiKey, summarizeTextCore } from "./tts-core.js";
import { streamSpeech } from "./tts-streaming.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

// TTS core tests cover provider selection, synthesis, and error handling.

const modelOverridePolicy: SpeechModelOverridePolicy = {
  enabled: false,
  allowText: false,
  allowProvider: false,
  allowVoice: false,
  allowModelId: false,
  allowVoiceSettings: false,
  allowNormalization: false,
  allowSeed: false,
};

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("TTS core", () => {
  it("keeps summarization-only LLM modules lazy", () => {
    const source = readFileSync(new URL("./tts-core.ts", import.meta.url), "utf8");

    expect(source).toContain('import("../agents/simple-completion-runtime.js")');
    expect(source).not.toContain('from "../llm/stream.js"');
    expect(source).not.toContain('from "../agents/simple-completion-runtime.js"');
    expect(source).not.toContain('from "../agents/model-auth.js"');
  });

  it("resolves the first non-blank speech provider API key", () => {
    expect(resolveSpeechProviderApiKey(undefined, " \t", "  provider-key  ", "fallback")).toBe(
      "provider-key",
    );
    expect(resolveSpeechProviderApiKey(undefined, "\n")).toBeUndefined();
  });

  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = {
        id: "test-model",
        name: "Test Model",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      } satisfies Model;
      const config = {
        auto: "off",
        mode: "final",
        provider: "test-provider",
        providerSource: "config",
        personas: {},
        summaryModel: "test-provider/test-model",
        modelOverrides: modelOverridePolicy,
        providerConfigs: {},
        maxTextLength: 10_000,
        timeoutMs: 10_000,
      } satisfies ResolvedTtsConfig;
      const auth = {
        apiKey: "key",
        source: "test",
        mode: "api-key",
      } as const;
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Short summary." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        usage,
        timestamp: Date.now(),
      } satisfies AssistantMessage;

      const result = await summarizeTextCore(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeWithPreparedSimpleCompletionModel: vi.fn(async () => assistant),
          acquireSimpleCompletionModel: vi.fn(async () => ({ model, auth, release: vi.fn() })),
          requireApiKey: vi.fn(() => "key"),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("TTS stream resource lifetime", () => {
  function createSpeechFixture(options: { locked?: boolean } = {}) {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE voice (text TEXT); INSERT INTO voice VALUES ('retained audio')");
    const cancellationEntered = createDeferredCore();
    const cancellationFinished = createDeferredCore();
    const releaseEntered = createDeferredCore();
    const releaseFinished = createDeferredCore();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const audioStream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      async cancel() {
        cancellationEntered.resolve();
        await cancellationFinished.promise;
        expect(db.prepare("SELECT text FROM voice").get()?.text).toBe("retained audio");
      },
    });
    const lockedReader = options.locked ? audioStream.getReader() : undefined;
    const registry = createEmptyPluginRegistry();
    let releases = 0;
    registry.speechProviders.push({
      pluginId: "resource-speech",
      source: "synthetic-fixture",
      provider: {
        id: "resource-speech",
        label: "Resource speech",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("unused"),
          outputFormat: "pcm",
          fileExtension: ".pcm",
          voiceCompatible: false,
        }),
        streamSynthesize: async () => ({
          audioStream,
          fileExtension: ".pcm",
          outputFormat: "pcm",
          voiceCompatible: false,
          async release() {
            releases += 1;
            releaseEntered.resolve();
            await releaseFinished.promise;
            expect(db.prepare("SELECT text FROM voice").get()?.text).toBe("retained audio");
            lockedReader?.releaseLock();
          },
        }),
      },
    });
    const owner = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "resource-speech", {
      id: "native-speech-database",
      dispose: () => db.close(),
    });
    return {
      db,
      owner,
      controller,
      cancellationEntered,
      cancellationFinished,
      releaseEntered,
      releaseFinished,
      releases: () => releases,
      start: () =>
        withPluginRuntimeRegistryScope(registry, () =>
          streamSpeech({
            text: "Read the native resource through stream completion.",
            cfg: { tts: { provider: "resource-speech" } },
            prefsPath: path.join(os.tmpdir(), `openclaw-speech-resources-${randomUUID()}.json`),
          }),
        ),
    };
  }

  it.each(["eof", "cancel", "release", "error"] as const)(
    "retains native registration resources until stream %s cleanup settles",
    async (mode) => {
      const fixture = createSpeechFixture();
      let result: Awaited<ReturnType<typeof streamSpeech>> | undefined;
      try {
        result = await fixture.start();
        expect(result.success).toBe(true);
        const reader = result.audioStream!.getReader();
        fixture.owner.release();
        const streamError = new Error("provider stream failed");
        const read = reader.read().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let completion: Promise<unknown>;
        if (mode === "eof") {
          fixture.controller.close();
          completion = read;
        } else if (mode === "error") {
          fixture.controller.error(streamError);
          completion = read;
        } else {
          completion = mode === "cancel" ? reader.cancel() : result.release!();
          await fixture.cancellationEntered.promise;
          expect(fixture.releases()).toBe(0);
          expect(fixture.db.isOpen).toBe(true);
          fixture.cancellationFinished.resolve();
        }
        await fixture.releaseEntered.promise;
        let drained = false;
        const drain = drainPluginRegistryResourceDisposals().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(fixture.db.isOpen).toBe(true);
        fixture.releaseFinished.resolve();
        await completion;
        expect(await read).toEqual(
          mode === "error" ? { error: streamError } : { value: { done: true, value: undefined } },
        );
        await drain;
        expect(fixture.db.isOpen).toBe(false);
        await result.release?.();
        expect(fixture.releases()).toBe(1);
      } finally {
        fixture.cancellationFinished.resolve();
        fixture.releaseFinished.resolve();
        await result?.release?.();
        fixture.owner.release();
        await drainPluginRegistryResourceDisposals();
      }
    },
  );

  it("releases the returned provider transport when its stream is already locked", async () => {
    const fixture = createSpeechFixture({ locked: true });
    fixture.cancellationFinished.resolve();
    fixture.releaseFinished.resolve();
    try {
      await expect(fixture.start()).rejects.toBeInstanceOf(TypeError);
      expect(fixture.releases()).toBe(1);
    } finally {
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
    }
    expect(fixture.db.isOpen).toBe(false);
  });

  it("preserves buffered audio after explicit transport release without reopening its scope", async () => {
    const fixture = createSpeechFixture();
    fixture.controller.enqueue(Buffer.from("buffered audio"));
    fixture.cancellationFinished.resolve();
    fixture.releaseFinished.resolve();
    let result: Awaited<ReturnType<typeof streamSpeech>> | undefined;
    try {
      result = await fixture.start();
      expect(result.success).toBe(true);
      await Promise.resolve();
      fixture.owner.release();
      await result.release?.();
      const reader = result.audioStream!.getReader();
      const chunk = await reader.read();
      expect(Buffer.from(chunk.value!).toString()).toBe("buffered audio");
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      await result?.release?.();
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
    }
  });
});
