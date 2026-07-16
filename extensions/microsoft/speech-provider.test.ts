// Microsoft tests cover speech provider plugin behavior.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  finalizeDebugProxyCapture,
  getDebugProxyCaptureStore,
  initializeDebugProxyCapture,
} from "openclaw/plugin-sdk/proxy-capture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      fetchWithSsrFGuardMock(...args);
      return actual.fetchWithSsrFGuard(...args);
    },
  };
});

vi.mock("node-edge-tts", () => ({
  EdgeTTS: class {
    async ttsPromise(): Promise<void> {}
  },
}));

import { buildMicrosoftSpeechProvider } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

const TEST_CFG = {} as OpenClawConfig;

async function listVoicesThroughProvider() {
  const listVoices = buildMicrosoftSpeechProvider().listVoices;
  if (!listVoices) {
    throw new Error("expected Microsoft voice listing support");
  }
  return await listVoices({ providerConfig: {} });
}

function requireFirstEdgeTtsCall(edgeSpy: ReturnType<typeof vi.spyOn>): {
  config?: unknown;
  outputPath: string;
  text?: string;
  timeoutMs?: number;
} {
  const [call] = edgeSpy.mock.calls;
  if (!call) {
    throw new Error("expected Microsoft Edge TTS call");
  }
  const [edgeCall] = call;
  if (!edgeCall || typeof edgeCall !== "object" || Array.isArray(edgeCall)) {
    throw new Error("expected Microsoft Edge TTS call");
  }
  return edgeCall as {
    config?: unknown;
    outputPath: string;
    text?: string;
    timeoutMs?: number;
  };
}

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

    const voices = await listVoicesThroughProvider();

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
    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listVoicesThroughProvider()).rejects.toThrow("Microsoft voices API error (503)");
  });

  it("prefers the configured provider request timeout", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("[]", { status: 200 })) as unknown as typeof globalThis.fetch;
    const listVoices = buildMicrosoftSpeechProvider().listVoices;
    if (!listVoices) {
      throw new Error("expected Microsoft voice listing support");
    }

    await listVoices({ providerConfig: { timeoutMs: 2_345 }, timeoutMs: 1_234 });

    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 2_345 }),
    );
  });

  it("records voice discovery exchanges in debug proxy capture mode", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "microsoft-voices-capture-"));
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-session";

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }]), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    const store = getDebugProxyCaptureStore();
    store.upsertSession({
      id: "ms-voices-session",
      startedAt: Date.now(),
      mode: "test",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
    });

    await listVoicesThroughProvider();

    await vi.waitFor(() => {
      const events = store.getSessionEvents("ms-voices-session", 10);
      expect(
        events.some(
          (event) => event.kind === "request" && event.host === "speech.platform.bing.com",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.kind === "response" && event.host === "speech.platform.bing.com",
        ),
      ).toBe(true);
    });
  });

  it("does not double-capture voice discovery when the global fetch patch is installed", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "microsoft-voices-global-"));
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-global-session";

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural" }]), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const store = getDebugProxyCaptureStore();
    store.upsertSession({
      id: "ms-voices-global-session",
      startedAt: Date.now(),
      mode: "test",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
    });
    initializeDebugProxyCapture("test");

    try {
      await listVoicesThroughProvider();

      let events: Array<Record<string, unknown>> = [];
      await vi.waitFor(() => {
        events = store
          .getSessionEvents("ms-voices-global-session", 10)
          .filter((event) => event.host === "speech.platform.bing.com");
        expect(events).toHaveLength(2);
      });
      const kinds = events.map((event) => String(event.kind)).toSorted();
      expect(kinds).toEqual(["request", "response"]);
    } finally {
      globalThis.fetch = proxyReset.originalFetch;
      finalizeDebugProxyCapture();
    }
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

    expect(edgeSpy).toHaveBeenCalledOnce();
    const edgeCall = requireFirstEdgeTtsCall(edgeSpy);
    expect(edgeCall.text).toBe("你好，这是一个测试 hello");
    expect(path.basename(edgeCall.outputPath)).toBe("speech.mp3");
    expect(edgeCall.timeoutMs).toBe(1000);
    expect(edgeCall.config).toEqual({
      enabled: true,
      voice: "zh-CN-XiaoxiaoNeural",
      lang: "zh-CN",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      outputFormatConfigured: true,
      pitch: undefined,
      rate: undefined,
      volume: undefined,
      saveSubtitles: false,
      proxy: undefined,
      timeoutMs: undefined,
    });
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

    expect(edgeSpy).toHaveBeenCalledOnce();
    const edgeCall = requireFirstEdgeTtsCall(edgeSpy);
    expect(edgeCall.text).toBe("你好，这是一个测试 hello");
    expect(path.basename(edgeCall.outputPath)).toBe("speech.mp3");
    expect(edgeCall.timeoutMs).toBe(1000);
    expect(edgeCall.config).toEqual({
      enabled: true,
      voice: "en-US-AvaNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      outputFormatConfigured: true,
      pitch: undefined,
      rate: undefined,
      volume: undefined,
      saveSubtitles: false,
      proxy: undefined,
      timeoutMs: undefined,
    });
  });
});
