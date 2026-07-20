// Transcript append redaction tests cover secret scrubbing when appending transcript entries.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

const readLoggingConfig = vi.hoisted(() => vi.fn());

vi.mock("../../logging/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/config.js")>();
  return {
    ...actual,
    readLoggingConfig,
  };
});

const EMAIL_PATTERN = String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`;
const IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAARcnVOZAAAAKIDABCDEFGHIJKLMNOP8JJRuAAAAABJRU5ErkJggg==";

function readMessages(sessionFile: string) {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((r) => r.type === "message")
    .map((r) => r.message);
}

async function readStoredMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  return (await loadTranscriptEvents(params))
    .map((event) => event as { type?: string; message?: unknown })
    .filter((record) => record.type === "message")
    .map((record) => record.message);
}

describe("appendSessionTranscriptMessage - redaction", () => {
  const fixture = useTempSessionsFixture("transcript-redact-test-");

  beforeEach(() => {
    readLoggingConfig.mockReset();
    readLoggingConfig.mockReturnValue(undefined);
  });

  it("masks secrets in message content before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-on", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz ok" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok"); // safe text preserved

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
    }>;
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).text,
    ).not.toContain("sk-abcdef1234567890xyz");
  });

  it("preserves image base64 payloads before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-image-base64",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [
          { type: "text", text: "my key is sk-abcdef1234567890xyz" },
          {
            type: "image",
            data: IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
            mimeType: "image/png",
          },
        ],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain(IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING);
    expect(raw).not.toContain("AKID…MNOP");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ type: string; text?: string; data?: string }>;
    }>;
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).text,
    ).not.toContain("sk-abcdef1234567890xyz");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[1],
        "msg.content[1] test invariant",
      ).data,
    ).toBe(IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING);
  });

  it("writes content unchanged when redactSensitive is off", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-off", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets when config is undefined (default patterns)", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-undef", fixture.sessionsDir());

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      // config intentionally omitted
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets in string payloads without role before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-string-payload",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: "my key is sk-abcdef1234567890xyz ok",
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok");

    const [msg] = readMessages(sessionFile) as string[];
    expect(msg).not.toContain("sk-abcdef1234567890xyz");
    expect(msg).toContain("ok");
  });

  it("masks secrets in structured payloads without role before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-structured-no-role",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        apiKey: "plainsecretvalue123",
        password: "hunter2",
        nested: { accessToken: ["nestedplainsecret123"] },
        command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
        safe: "visible",
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("nestedplainsecret123");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("visible");

    const [msg] = readMessages(sessionFile) as Array<{
      apiKey: string;
      password: string;
      nested: { accessToken: string[] };
      command: string;
      safe: string;
    }>;
    expect(expectDefined(msg, "msg test invariant").apiKey).toBe("plains…e123");
    expect(expectDefined(msg, "msg test invariant").password).toBe("***");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").nested.accessToken[0],
        "msg.nested.accessToken[0] test invariant",
      ),
    ).toBe("nested…t123");
    expect(expectDefined(msg, "msg test invariant").command).toBe(
      "OPENAI_API_KEY=sk-abc…0xyz openclaw health",
    );
    expect(expectDefined(msg, "msg test invariant").safe).toBe("visible");
  });

  it("uses configured custom patterns when cfg omits logging", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-config-pattern-fallback",
      fixture.sessionsDir(),
    );
    readLoggingConfig.mockReturnValue({
      redactSensitive: "tools",
      redactPatterns: [EMAIL_PATTERN],
    });

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "email peter@dc.io and key sk-abcdef1234567890xyz ok" }],
      },
      config: {
        session: {},
      },
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("peter@dc.io");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok");
  });

  it("masks secrets in assistant tool-call arguments before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-tool-call-args",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "shell",
            arguments: {
              command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
              env: { nested: ["token sk-abcdef1234567890xyz"] },
              apiKey: "plainsecretvalue123",
              password: "hunter2",
            },
          },
        ],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(raw).toContain("openclaw health");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{
        arguments: {
          command: string;
          env: { nested: string[] };
          apiKey: string;
          password: string;
        };
      }>;
    }>;
    expect(
      JSON.stringify(
        expectDefined(
          expectDefined(msg, "msg test invariant").content[0],
          "msg.content[0] test invariant",
        ).arguments,
      ),
    ).not.toContain("sk-abcdef1234567890xyz");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).arguments.command,
    ).toBe("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).arguments.env.nested[0],
    ).toBe("token sk-abc…0xyz");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).arguments.apiKey,
    ).toBe("plains…e123");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).arguments.password,
    ).toBe("***");
  });

  it("masks secrets in tool-result details before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-tool-result-details",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "send_request",
        content: [{ type: "text", text: "result sk-abcdef1234567890xyz" }],
        details: {
          apiKey: "plainsecretvalue123",
          password: "hunter2",
          nested: { accessToken: ["nestedplainsecret123"] },
          safe: "visible",
        },
        isError: false,
        timestamp: Date.now(),
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("nestedplainsecret123");
    expect(raw).toContain("visible");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
      details: {
        apiKey: string;
        password: string;
        nested: { accessToken: string[] };
        safe: string;
      };
    }>;
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).text,
    ).not.toContain("sk-abcdef1234567890xyz");
    expect(JSON.stringify(expectDefined(msg, "msg test invariant").details)).not.toContain(
      "plainsecretvalue123",
    );
    expect(expectDefined(msg, "msg test invariant").details.apiKey).toBe("plains…e123");
    expect(expectDefined(msg, "msg test invariant").details.password).toBe("***");
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").details.nested.accessToken[0],
        "msg.details.nested.accessToken[0] test invariant",
      ),
    ).toBe("nested…t123");
  });

  it("preserves env placeholders in persisted tool results", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "issue-80379-tool-result-env-placeholders",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };
    const toolOutput =
      'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"\nTELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"';

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "toolResult",
        toolCallId: "call_80379",
        toolName: "read",
        content: [{ type: "text", text: toolOutput }],
        isError: false,
        timestamp: Date.now(),
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).toContain("${DISCORD_BOT_TOKEN:-}");
    expect(raw).toContain("${TELEGRAM_BOT_TOKEN:-}");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
    }>;
    expect(
      expectDefined(
        expectDefined(msg, "msg test invariant").content[0],
        "msg.content[0] test invariant",
      ).text,
    ).toBe(toolOutput);
  });
});

describe("appendExactAssistantMessageToSessionTranscript - redaction", () => {
  const fixture = useTempSessionsFixture("exact-assistant-redact-test-");

  async function seedSessionEntry(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) {
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      { sessionId: params.sessionId, updatedAt: Date.now() },
    );
  }

  it("does not redact when config.logging.redactSensitive is off", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-off";
    const sessionKey = "test-channel:test-user";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
        api: "openai-responses",
        provider: "openclaw",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const raw = JSON.stringify(await readStoredMessages({ sessionId, sessionKey, storePath }));
    expect(raw).toContain(fakeApiKey);
  });

  it("emits the redacted assistant message for inline transcript updates", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-event";
    const sessionKey = "test-channel:test-redact-event";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const result = await appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        config,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
          api: "openai-responses",
          provider: "openclaw",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const [diskMessage] = await readStoredMessages({ sessionId, sessionKey, storePath });
      expect(JSON.stringify(diskMessage)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toEqual(diskMessage);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
    }
  });

  it("dedupes delivery mirrors against the redacted persisted text", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-dedupe";
    const sessionKey = "test-channel:test-redact-dedupe";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.messageId).toBe(first.messageId);

    const events = await loadTranscriptEvents({ sessionId, sessionKey, storePath });
    expect(JSON.stringify(events)).not.toContain(fakeApiKey);
    expect(events.filter((event) => (event as { type?: unknown }).type === "message")).toHaveLength(
      1,
    );
  });

  it("dedupes delivery mirrors against older unredacted assistant entries", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-upgrade-dedupe";
    const sessionKey = "test-channel:test-redact-upgrade-dedupe";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-OLDERUNREDACTEDTRANSCRIPT1234567890";
    const unredacted = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config: { logging: { redactSensitive: "off" } },
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
        api: "openai-responses",
        provider: "openclaw",
        model: "legacy-assistant",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    const deduped = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config: { logging: { redactSensitive: "tools" } },
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(unredacted.ok).toBe(true);
    expect(deduped.ok).toBe(true);
    if (!unredacted.ok || !deduped.ok) {
      return;
    }
    expect(deduped.messageId).toBe(unredacted.messageId);

    const events = await loadTranscriptEvents({ sessionId, sessionKey, storePath });
    expect(JSON.stringify(events)).toContain(fakeApiKey);
    expect(events.filter((event) => (event as { type?: unknown }).type === "message")).toHaveLength(
      1,
    );
  });
});
