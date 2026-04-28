import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  finalizeDebugProxyCapture,
  getDebugProxyCaptureStore,
  initializeDebugProxyCapture,
} from "openclaw/plugin-sdk/proxy-capture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";

vi.mock("node-edge-tts", () => ({
  EdgeTTS: class {
    async ttsPromise(): Promise<void> {}
  },
}));

import {
  buildMicrosoftSpeechProvider,
  isCjkDominant,
  listMicrosoftVoices,
} from "./speech-provider.js";
import * as ttsModule from "./tts.js";

const TEST_CFG = {} as OpenClawConfig;

describe("listMicrosoftVoices", () => {
  const proxyReset = installDebugProxyTestResetHooks();

  it("maps Microsoft voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "en-US-AvaNeural",
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
            Locale: "en-US",
            Gender: "Female",
            VoiceTag: {
              ContentCategories: ["General"],
              VoicePersonalities: ["Friendly", "Positive"],
            },
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listMicrosoftVoices();

    expect(voices).toEqual([
      {
        id: "en-US-AvaNeural",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        category: "General",
        description: "Friendly, Positive",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
      },
    ]);
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listMicrosoftVoices()).rejects.toThrow("Microsoft voices API error (503)");
  });

  it("records voice discovery exchanges in debug proxy capture mode", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "microsoft-voices-capture-"));
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-session";

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }]), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    const store = getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
    );
    store.upsertSession({
      id: "ms-voices-session",
      startedAt: Date.now(),
      mode: "test",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      dbPath: process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
      blobDir: process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
    });

    await listMicrosoftVoices();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = store.getSessionEvents("ms-voices-session", 10);
    expect(
      events.some((event) => event.kind === "request" && event.host === "speech.platform.bing.com"),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.kind === "response" && event.host === "speech.platform.bing.com",
      ),
    ).toBe(true);
  });

  it("does not double-capture voice discovery when the global fetch patch is installed", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "microsoft-voices-global-"));
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-global-session";

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }]), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const store = getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
    );
    store.upsertSession({
      id: "ms-voices-global-session",
      startedAt: Date.now(),
      mode: "test",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      dbPath: process.env.OPENCLAW_DEBUG_PROXY_DB_PATH,
      blobDir: process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR,
    });
    initializeDebugProxyCapture("test");

    try {
      await listMicrosoftVoices();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const events = store
        .getSessionEvents("ms-voices-global-session", 10)
        .filter((event) => event.host === "speech.platform.bing.com");
      expect(events).toHaveLength(2);
      const kinds = events.map((event) => String(event.kind)).toSorted();
      expect(kinds).toEqual(["request", "response"]);
    } finally {
      globalThis.fetch = proxyReset.originalFetch;
      finalizeDebugProxyCapture();
    }
  });
});

describe("isCjkDominant", () => {
  it("returns true for Chinese text", () => {
    expect(isCjkDominant("你好世界")).toBe(true);
  });

  it("returns true for mixed text with majority CJK", () => {
    expect(isCjkDominant("你好，这是一个测试 hello")).toBe(true);
  });

  it("returns false for English text", () => {
    expect(isCjkDominant("Hello, this is a test")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCjkDominant("")).toBe(false);
  });

  it("returns false for mostly English with a few CJK chars", () => {
    expect(isCjkDominant("This is a long English sentence with one 字")).toBe(false);
  });
});

describe("buildMicrosoftSpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches to a Chinese voice for CJK text when no explicit voice override is set", async () => {
    const provider = buildMicrosoftSpeechProvider();
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await provider.synthesize({
      text: "你好，这是一个测试 hello",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
      },
      providerOverrides: {},
      timeoutMs: 1000,
      target: "audio-file",
    });

    expect(edgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          voice: "zh-CN-XiaoxiaoNeural",
          lang: "zh-CN",
        }),
      }),
    );
  });

  it("preserves an explicitly configured English voice for CJK text", async () => {
    const provider = buildMicrosoftSpeechProvider();
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await provider.synthesize({
      text: "你好，这是一个测试 hello",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        voice: "en-US-AvaNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
      },
      providerOverrides: {},
      timeoutMs: 1000,
      target: "audio-file",
    });

    expect(edgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          voice: "en-US-AvaNeural",
          lang: "en-US",
        }),
      }),
    );
  });
});
