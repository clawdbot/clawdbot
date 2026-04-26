import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const ttsMocks = vi.hoisted(() => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getLastTtsAttempt: vi.fn(),
  getTtsMaxLength: vi.fn(),
  getTtsPersona: vi.fn(),
  getTtsProvider: vi.fn(),
  isSummarizationEnabled: vi.fn(),
  isTtsEnabled: vi.fn(),
  isTtsProviderConfigured: vi.fn(),
  listTtsPersonas: vi.fn(),
  resolveTtsConfig: vi.fn(),
  resolveTtsPrefsPath: vi.fn(),
  setLastTtsAttempt: vi.fn(),
  setSummarizationEnabled: vi.fn(),
  setTtsEnabled: vi.fn(),
  setTtsMaxLength: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  getSpeechProvider: vi.fn(() => null),
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ttsMocks);

const { handleTtsCommands } = await import("./commands-tts.js");
const PRIMARY_TTS_PROVIDER = "acme-speech";
const FALLBACK_TTS_PROVIDER = "backup-speech";

function buildTtsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
  agentId?: string,
  overrides: Partial<Parameters<typeof handleTtsCommands>[0]> = {},
): Parameters<typeof handleTtsCommands>[0] {
  return {
    cfg,
    agentId,
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "forum",
    },
    sessionKey: "session-key",
    ...overrides,
  } as unknown as Parameters<typeof handleTtsCommands>[0];
}

describe("handleTtsCommands status fallback reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ttsMocks.resolveTtsConfig.mockReturnValue({});
    ttsMocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts-prefs.json");
    ttsMocks.isTtsEnabled.mockReturnValue(true);
    ttsMocks.getTtsProvider.mockReturnValue(PRIMARY_TTS_PROVIDER);
    ttsMocks.getTtsPersona.mockReturnValue(undefined);
    ttsMocks.isTtsProviderConfigured.mockReturnValue(true);
    ttsMocks.getTtsMaxLength.mockReturnValue(1500);
    ttsMocks.isSummarizationEnabled.mockReturnValue(true);
    ttsMocks.getLastTtsAttempt.mockReturnValue(undefined);
    ttsMocks.listTtsPersonas.mockReturnValue([]);
  });

  it("shows fallback provider details for successful attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      timestamp: Date.now() - 1_000,
      success: true,
      textLength: 128,
      summarized: false,
      provider: FALLBACK_TTS_PROVIDER,
      fallbackFrom: PRIMARY_TTS_PROVIDER,
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          provider: PRIMARY_TTS_PROVIDER,
          outcome: "failed",
          reasonCode: "provider_error",
          latencyMs: 73,
        },
        {
          provider: FALLBACK_TTS_PROVIDER,
          outcome: "success",
          reasonCode: "success",
          latencyMs: 420,
        },
      ],
      latencyMs: 420,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      `Fallback: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(provider_error) 73ms, ${FALLBACK_TTS_PROVIDER}:success(ok) 420ms`,
    );
  });

  it("shows attempted provider chain for failed attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      timestamp: Date.now() - 1_000,
      success: false,
      textLength: 128,
      summarized: false,
      error: "TTS conversion failed",
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          provider: PRIMARY_TTS_PROVIDER,
          outcome: "failed",
          reasonCode: "timeout",
          latencyMs: 999,
        },
      ],
      latencyMs: 420,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Error: TTS conversion failed");
    expect(result?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(result?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(timeout) 999ms`,
    );
  });

  it("persists fallback metadata from /tts audio and renders it in /tts status", async () => {
    let lastAttempt: Record<string, unknown> | undefined;
    ttsMocks.getLastTtsAttempt.mockImplementation(() => lastAttempt);
    ttsMocks.setLastTtsAttempt.mockImplementation((next: Record<string, unknown>) => {
      lastAttempt = next;
    });
    ttsMocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/fallback.ogg",
      provider: FALLBACK_TTS_PROVIDER,
      fallbackFrom: PRIMARY_TTS_PROVIDER,
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          provider: PRIMARY_TTS_PROVIDER,
          outcome: "failed",
          reasonCode: "provider_error",
          latencyMs: 65,
        },
        {
          provider: FALLBACK_TTS_PROVIDER,
          outcome: "success",
          reasonCode: "success",
          latencyMs: 175,
        },
      ],
      latencyMs: 175,
      voiceCompatible: true,
    });

    const audioResult = await handleTtsCommands(buildTtsParams("/tts audio hello world"), true);
    expect(audioResult?.shouldContinue).toBe(false);
    expect(audioResult?.reply?.mediaUrl).toBe("/tmp/fallback.ogg");

    const statusResult = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(statusResult?.shouldContinue).toBe(false);
    expect(statusResult?.reply?.text).toContain(`Provider: ${FALLBACK_TTS_PROVIDER}`);
    expect(statusResult?.reply?.text).toContain(
      `Fallback: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusResult?.reply?.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusResult?.reply?.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(provider_error) 65ms, ${FALLBACK_TTS_PROVIDER}:success(ok) 175ms`,
    );
  });

  it("treats bare /tts as status", async () => {
    const result = await handleTtsCommands(
      buildTtsParams("/tts", {
        messages: { tts: { prefsPath: "/tmp/tts.json" } },
      } as OpenClawConfig),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("TTS status");
  });

  it("resolves status config for the active agent", async () => {
    const cfg = {
      agents: { list: [{ id: "reader", tts: { provider: "elevenlabs" } }] },
    } as OpenClawConfig;

    const result = await handleTtsCommands(buildTtsParams("/tts status", cfg, "reader"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(ttsMocks.resolveTtsConfig).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({ agentId: "reader", channelId: "forum" }),
    );
  });

  it("passes the active agent and account ids to /tts audio synthesis", async () => {
    ttsMocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/reader.ogg",
      provider: PRIMARY_TTS_PROVIDER,
      voiceCompatible: true,
    });
    const cfg = {
      agents: { list: [{ id: "reader", tts: { provider: PRIMARY_TTS_PROVIDER } }] },
    } as OpenClawConfig;

    const result = await handleTtsCommands(
      buildTtsParams("/tts audio hello", cfg, "reader", {
        ctx: { AccountId: "feishu-main" },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(ttsMocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        cfg,
        agentId: "reader",
        accountId: "feishu-main",
      }),
    );
  });

  it("lists and sets configured TTS personas", async () => {
    ttsMocks.listTtsPersonas.mockReturnValue([
      {
        id: "alfred",
        label: "Alfred",
        provider: "google",
      },
    ]);

    const listResult = await handleTtsCommands(buildTtsParams("/tts persona"), true);
    expect(listResult?.shouldContinue).toBe(false);
    expect(listResult?.reply?.text).toContain("alfred (Alfred) provider=google");

    const setResult = await handleTtsCommands(buildTtsParams("/tts persona alfred"), true);
    expect(setResult?.shouldContinue).toBe(false);
    expect(ttsMocks.setTtsPersona).toHaveBeenCalledWith("/tmp/tts-prefs.json", "alfred");
  });

  it("reads the latest assistant transcript reply once", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-latest-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "older reply" }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "internal note",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "item_commentary",
                  phase: "commentary",
                }),
              },
              {
                type: "text",
                text: "latest visible reply",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "item_final",
                  phase: "final_answer",
                }),
              },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    ttsMocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/latest.ogg",
      provider: PRIMARY_TTS_PROVIDER,
      voiceCompatible: true,
    });
    const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1, sessionFile };
    const sessionStore = { "session-key": sessionEntry };

    const result = await handleTtsCommands(
      buildTtsParams("/tts latest", {}, undefined, { sessionEntry, sessionStore }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toMatchObject({
      mediaUrl: "/tmp/latest.ogg",
      audioAsVoice: true,
      spokenText: "latest visible reply",
    });
    expect(ttsMocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ text: "latest visible reply" }),
    );
    expect(sessionEntry.lastTtsReadLatestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionEntry.lastTtsReadLatestAt).toEqual(expect.any(Number));
  });

  it("does not resend /tts latest for the same assistant reply", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-latest-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "read me once" }] },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    ttsMocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/latest.ogg",
      provider: PRIMARY_TTS_PROVIDER,
      voiceCompatible: true,
    });
    const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1, sessionFile };
    const sessionStore = { "session-key": sessionEntry };
    const params = buildTtsParams("/tts latest", {}, undefined, { sessionEntry, sessionStore });

    const first = await handleTtsCommands(params, true);
    expect(first?.reply?.mediaUrl).toBe("/tmp/latest.ogg");
    ttsMocks.textToSpeech.mockClear();

    const second = await handleTtsCommands(params, true);

    expect(second?.reply?.text).toContain("already sent");
    expect(ttsMocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("stores chat-scoped TTS overrides on the session entry", async () => {
    const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
    const sessionStore = { "session-key": sessionEntry };

    const onResult = await handleTtsCommands(
      buildTtsParams("/tts chat on", {}, undefined, { sessionEntry, sessionStore }),
      true,
    );
    expect(onResult?.reply?.text).toContain("enabled for this chat");
    expect(sessionEntry.ttsAuto).toBe("always");

    const offResult = await handleTtsCommands(
      buildTtsParams("/tts chat off", {}, undefined, { sessionEntry, sessionStore }),
      true,
    );
    expect(offResult?.reply?.text).toContain("disabled for this chat");
    expect(sessionEntry.ttsAuto).toBe("off");

    const clearResult = await handleTtsCommands(
      buildTtsParams("/tts chat default", {}, undefined, { sessionEntry, sessionStore }),
      true,
    );
    expect(clearResult?.reply?.text).toContain("override cleared");
    expect(sessionEntry.ttsAuto).toBeUndefined();
  });
});
