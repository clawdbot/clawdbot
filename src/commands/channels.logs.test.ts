// Channels logs tests cover gateway log path resolution and channel log tailing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  listPluginContributionIds: vi.fn(() => ["external-chat"]),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();

function logLine(params: { module: string; message: string }) {
  return JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: params.message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify({ module: params.module }),
    },
  });
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    file: string;
    channel: string;
    lines: Array<{ message: string }>;
  };
}

describe("channelsLogsCommand", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channels-logs-"));
    logPath = path.join(tempDir, "openclaw.log");
    setLoggerOverride({ file: logPath });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockClear();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
  });

  afterEach(async () => {
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ module: "gateway/channels/external-chat/send", message: "external sent" }),
        logLine({ module: "gateway/channels/slack/send", message: "slack sent" }),
      ].join("\n"),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).toHaveBeenCalledOnce();
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledOnce();
    const [contributionOptions] = pluginRegistryMocks.listPluginContributionIds.mock
      .calls[0] as unknown as [{ contribution?: string; includeDisabled?: boolean }];
    expect(contributionOptions?.contribution).toBe("channels");
    expect(contributionOptions?.includeDisabled).toBe(true);
    const payload = readJsonPayload();
    expect(payload.channel).toBe("external-chat");
    expect(payload.lines.map((line) => line.message)).toEqual(["external sent"]);
  });

  it("falls back to the latest rolling log when the configured rolling file is missing", async () => {
    const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    const staleFile = path.join(tempDir, "openclaw-2026-04-24.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      [
        logLine({ module: "gateway/channels/slack/send", message: "slack fallback" }),
        logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
      ].join("\n"),
    );
    await fs.writeFile(
      staleFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "stale sent" }),
    );
    await fs.utimes(
      staleFile,
      new Date("2026-04-24T12:00:00.000Z"),
      new Date("2026-04-24T12:00:00.000Z"),
    );
    await fs.utimes(
      fallbackFile,
      new Date("2026-04-25T12:00:00.000Z"),
      new Date("2026-04-25T12:00:00.000Z"),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(fallbackFile);
    expect(payload.lines.map((line) => line.message)).toEqual(["fallback sent"]);
  });

  it("prefers the configured rolling log when it exists", async () => {
    const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
    );
    await fs.writeFile(
      configuredFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "current sent" }),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(configuredFile);
    expect(payload.lines.map((line) => line.message)).toEqual(["current sent"]);
  });

  it("returns the first line of the tail window when start aligns with a line boundary", async () => {
    // MAX_BYTES in readTailLines is 1_000_000. We build a file of 2_000_000 bytes
    // made of 10_000 lines each exactly 200 bytes (199 payload + "\n"), so the
    // read window starts at byte offset 1_000_000 which is exactly on a line
    // boundary (byte 999_999 is the trailing "\n" of the previous line).
    // Without checking the byte before the window, readTailLines drops line 5000 silently.
    const LINE_SIZE = 200;
    const TOTAL_LINES = 10_000;
    const FIRST_INDEX = 5000; // first line of the tail window after alignment

    const buildLine = (message: string) => {
      const base = logLine({
        module: "gateway/channels/slack/send",
        message,
      });
      const payloadLen = LINE_SIZE - 1; // reserve 1 byte for newline
      // Re-emit with a padded message so total byte length is constant.
      const padNeeded = payloadLen - Buffer.byteLength(base);
      if (padNeeded < 0) {
        throw new Error(`base log line too long: ${Buffer.byteLength(base)} > ${payloadLen}`);
      }
      const padded = logLine({
        module: "gateway/channels/slack/send",
        message: message + " ".repeat(padNeeded),
      });
      if (Buffer.byteLength(padded) !== payloadLen) {
        throw new Error(`padded line wrong size: ${Buffer.byteLength(padded)} vs ${payloadLen}`);
      }
      return padded + "\n";
    };

    const handle = await fs.open(logPath, "w");
    try {
      for (let i = 0; i < TOTAL_LINES; i++) {
        let message: string;
        if (i === FIRST_INDEX) {
          message = "first-line-in-window";
        } else if (i === TOTAL_LINES - 1) {
          message = "last-line";
        } else {
          message = "filler";
        }
        await handle.write(buildLine(message));
      }
    } finally {
      await handle.close();
    }

    await channelsLogsCommand(
      { channel: "slack", json: true, lines: String(TOTAL_LINES) },
      runtime,
    );

    const payload = readJsonPayload();
    const messages = payload.lines.map((line) => line.message.trimEnd());
    expect(messages[0]).toBe("first-line-in-window");
    expect(messages[messages.length - 1]).toBe("last-line");
  });

  it("does not fall back to rolling logs for a missing custom log file", async () => {
    const configuredFile = path.join(tempDir, "custom-channel.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(configuredFile);
    expect(payload.lines).toStrictEqual([]);
  });

  it("rejects partial line limits", async () => {
    await expect(channelsLogsCommand({ lines: "2x", json: true }, runtime)).rejects.toThrow(
      "--lines must be a positive integer.",
    );
  });
});
