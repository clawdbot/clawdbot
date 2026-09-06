// Channels logs tests cover gateway log path resolution and channel log tailing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChildLogger, setLoggerOverride } from "../logging.js";
import { flushLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => {
  const plugins = [{ id: "vendor-external-chat", channels: ["external-chat"] }];
  return {
    loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({ diagnostics: [], plugins })),
  };
});

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();
function logLine(params: {
  subsystem?: string;
  module?: string;
  plugin?: string;
  message: string;
}) {
  return `${JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: params.message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify({
        ...(params.subsystem ? { subsystem: params.subsystem } : {}),
        ...(params.module ? { module: params.module } : {}),
        ...(params.plugin ? { plugin: params.plugin } : {}),
      }),
    },
  })}\n`;
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    file: string;
    channel: string;
    truncated: boolean;
    lines: Array<{ message: string; raw: string }>;
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
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSecretRedactionRegistryForTest();
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ plugin: "vendor-external-chat", message: "external sent" }),
        logLine({ plugin: "vendor-external-chat-shadow", message: "shadow sent" }),
        logLine({ module: "gateway/channels/slack/send", message: "slack sent" }),
      ].join(""),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    expect(pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
      includeDisabled: true,
      env: process.env,
    });
    const payload = readJsonPayload();
    expect(payload.channel).toBe("external-chat");
    expect(payload.lines.map((line) => line.message)).toEqual(["external sent"]);
  });

  it.each([
    {
      label: "subsystem",
      channel: "slack",
      shadow: { subsystem: "gateway/channels/slack-archive" },
      match: { subsystem: "gateway/channels/slack/send" },
    },
    {
      label: "module",
      channel: "external-chat",
      shadow: { module: "external-chat-shadow" },
      match: { module: "external-chat" },
    },
    {
      label: "nested subsystem",
      channel: "slack",
      shadow: { subsystem: "slack-archive/send" },
      match: { subsystem: "slack/send" },
    },
    {
      label: "nested module",
      channel: "external-chat",
      shadow: { module: "external-chat-shadow/send" },
      match: { module: "external-chat/send" },
    },
  ])("matches channel boundaries and excludes a shadow $label", async (fixture) => {
    await fs.writeFile(
      logPath,
      [
        logLine({ ...fixture.shadow, message: "shadow" }),
        logLine({ ...fixture.match, message: "match" }),
      ].join(""),
    );

    await channelsLogsCommand({ channel: fixture.channel, json: true }, runtime);

    expect(readJsonPayload().lines.map((line) => line.message)).toEqual(["match"]);
  });

  it.each([false, true])(
    "rejects an unknown explicit channel without widening output (json=%s)",
    async (json) => {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "unrelated message" }),
      );

      const error = await channelsLogsCommand({ channel: "slakc", json }, runtime).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unknown channel "slakc". Valid channels: all,');
      expect((error as Error).message).toContain("external-chat");
      expect((error as Error).message).toContain("slack");
      expect(runtime.log).not.toHaveBeenCalled();
    },
  );

  it("redacts credential-bearing channel lines in text output", async () => {
    const fixtureCredential = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(fixtureCredential);
    await fs.writeFile(
      logPath,
      logLine({
        module: "gateway/channels/slack/send",
        message: `opaque=${fixtureCredential}`,
      }),
    );

    await channelsLogsCommand({ channel: "slack" }, runtime);

    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("2026-04-25T12:00:00.000Z info");
    expect(output).toContain("opaque=opaque…7890");
    expect(output).not.toContain(fixtureCredential);
  });

  it("redacts credential-bearing channel lines in JSON output", async () => {
    const fixtureCredential = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(fixtureCredential);
    await fs.writeFile(
      logPath,
      logLine({
        module: "gateway/channels/slack/send",
        message: `opaque=${fixtureCredential}`,
      }),
    );

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.lines[0]?.message).toBe("opaque=opaque…7890");
    expect(JSON.stringify(payload)).not.toContain(fixtureCredential);
  });

  it("preserves ordering and line limits for an explicit all filter", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ module: "gateway/channels/slack/send", message: "first" }),
        logLine({ module: "gateway/channels/external-chat/send", message: "second" }),
        logLine({ module: "gateway/channels/slack/send", message: "third" }),
      ].join(""),
    );

    await channelsLogsCommand({ channel: "all", lines: 2, json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.channel).toBe("all");
    expect(payload.lines.map((line) => line.message)).toEqual(["second", "third"]);
  });

  it("finds sparse channel records beyond the shared 5000-line cap", async () => {
    const filler = logLine({ module: "gateway/health", message: "ok" });
    const lines = [
      logLine({ module: "gateway/channels/slack/send", message: "first match" }),
      ...Array.from({ length: 5000 }, () => filler),
      logLine({ module: "gateway/channels/slack/send", message: "second match" }),
    ];
    await fs.writeFile(logPath, lines.join(""));

    await channelsLogsCommand({ channel: "slack", lines: 2000, json: true }, runtime);

    expect(readJsonPayload().lines.map((line) => line.message)).toEqual([
      "first match",
      "second match",
    ]);
  });

  it("reports when the byte window omits all matching channel records", async () => {
    const omitted = logLine({ module: "gateway/channels/slack/send", message: "omitted" });
    const filler = logLine({ module: "gateway/health", message: "x".repeat(1000) });
    await fs.writeFile(logPath, `${omitted}${filler.repeat(1100)}`);

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);
    expect(readJsonPayload()).toMatchObject({ truncated: true, lines: [] });

    runtime.log.mockClear();
    await channelsLogsCommand({ channel: "slack" }, runtime);
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "Log tail truncated; earlier entries were omitted.",
    );
  });

  it("treats an omitted channel filter as all", async () => {
    await fs.writeFile(
      logPath,
      logLine({ module: "gateway/channels/slack/send", message: "omitted filter" }),
    );

    await channelsLogsCommand({ json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.channel).toBe("all");
    expect(payload.lines.map((line) => line.message)).toEqual(["omitted filter"]);
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
      ].join(""),
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

  it("reads the active writer file instead of a newer stale configured rolling log", async () => {
    const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
    setLoggerOverride({ file: configuredFile, level: "info" });
    getChildLogger({ module: "gateway/channels/external-chat/send" }).warn("current sent");
    await flushLogger();

    const writtenFiles = await fs.readdir(tempDir);
    expect(writtenFiles).toEqual([expect.stringMatching(/^openclaw-\d{4}-\d{2}-\d{2}\.log$/)]);
    const activeFile = path.join(tempDir, expectDefined(writtenFiles[0], "active log file"));
    expect(activeFile).not.toBe(configuredFile);

    await fs.writeFile(
      configuredFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "stale sent" }),
    );
    const newerMtime = new Date((await fs.stat(activeFile)).mtimeMs + 60_000);
    await fs.utimes(configuredFile, newerMtime, newerMtime);

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(activeFile);
    expect(payload.lines.map((line) => line.message)).toEqual(["current sent"]);
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

  it("follows appended matching records without replaying the initial tail", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        [
          logLine({ module: "gateway/channels/slack/send", message: "existing" }),
          logLine({ module: "gateway/health", message: "unrelated" }),
        ].join(""),
      );

      const follow = channelsLogsCommand(
        { channel: "slack", lines: 1, follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.appendFile(
        logPath,
        [
          logLine({ module: "gateway/health", message: "ignored" }),
          logLine({ module: "gateway/channels/slack/receive", message: "appended" }),
          logLine({ module: "gateway/channels/slack/receive", message: "appended-second" }),
        ].join(""),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(4));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["existing", "appended", "appended-second"]);
      expect(records.some((record) => record.message === "ignored")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes text follow output to stdout without re-entering the logger", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "text follow" }),
      );
      const writeStdout = vi.fn();
      const followRuntime = {
        ...runtime,
        writeStdout,
        writeJson: vi.fn(),
      };
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10 },
        followRuntime,
      );

      await vi.waitFor(() => expect(writeStdout).toHaveBeenCalledTimes(3));
      expect(writeStdout.mock.calls.map(([value]) => String(value))).toEqual([
        expect.stringContaining("Log file:"),
        expect.stringContaining("Channel: slack"),
        "2026-04-25T12:00:00.000Z info text follow",
      ]);
      expect(runtime.log).not.toHaveBeenCalled();

      process.emit("SIGINT");
      await follow;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a short file when an append grows its prefix", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(logPath, '{"0":"first"}\n');
      const follow = channelsLogsCommand(
        { lines: 1, follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.appendFile(logPath, '{"0":"second"}\n');
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(3));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["first", "second"]);
      expect(records.some((record) => record.type === "notice")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("grows the prefix fingerprint after starting with an empty file", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(logPath, "");
      const follow = channelsLogsCommand(
        { lines: 1, follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(1));

      const firstMessage = `aaaaa${"x".repeat(200)}`;
      await fs.appendFile(logPath, logLine({ message: firstMessage }));
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      const replacementMessage = `bbbbb${"x".repeat(200)}`;
      await fs.writeFile(logPath, logLine({ message: replacementMessage }));
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(4));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual([firstMessage, replacementMessage]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-anchors after a same-path replacement without replaying the old cursor", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.writeFile(
        logPath,
        [
          logLine({ module: "gateway/channels/slack/send", message: "new-first" }),
          logLine({ module: "gateway/channels/slack/send", message: "new-second" }),
        ].join(""),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(5));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["before", "new-first", "new-second"]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a partial replacement anchored to one generation", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.writeFile(
        logPath,
        `${logLine({ module: "gateway/channels/slack/send", message: "new-first" })}${logLine({
          module: "gateway/channels/slack/send",
          message: "new-partial",
        }).trimEnd()}`,
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(4));
      await vi.advanceTimersByTimeAsync(10);

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["before", "new-first"]);

      process.emit("SIGINT");
      await follow;
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-anchors after a same-size rewrite between polls", async () => {
    vi.useFakeTimers();
    try {
      const oldMessage = `${"x".repeat(200)}-old`;
      const newMessage = `${"x".repeat(200)}-new`;
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: oldMessage }),
      );
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: newMessage }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(4));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual([oldMessage, newMessage]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-anchors after same-path truncate/regrow with matching edge samples", async () => {
    vi.useFakeTimers();
    try {
      const oldMessage = `${"x".repeat(200)}-old`;
      const newMessage = `${"x".repeat(200)}-new`;
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: oldMessage }),
      );
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.writeFile(
        logPath,
        [
          logLine({ module: "gateway/channels/slack/send", message: newMessage }),
          logLine({ module: "gateway/channels/slack/send", message: "new-second" }),
        ].join(""),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(5));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual([oldMessage, newMessage, "new-second"]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cursor stable while a poll observes an append", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      await fs.appendFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "appended" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(3));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["before", "appended"]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a complete record while a trailing record is incomplete", async () => {
    vi.useFakeTimers();
    try {
      const complete = logLine({ module: "gateway/channels/slack/send", message: "complete" });
      const partial = logLine({
        module: "gateway/channels/slack/send",
        message: "pending",
      }).trimEnd();
      await fs.writeFile(logPath, `${complete}${partial}`);

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(30);

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["complete"]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(0);

      process.emit("SIGINT");
      await follow;
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits quietly while the configured log file is absent", async () => {
    vi.useFakeTimers();
    try {
      const missingPath = path.join(tempDir, "missing.log");
      setLoggerOverride({ file: missingPath });
      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(30);

      expect(
        runtime.log.mock.calls
          .map(([value]) => JSON.parse(String(value)))
          .filter((record) => record.type === "notice"),
      ).toHaveLength(0);

      await fs.writeFile(
        missingPath,
        logLine({ module: "gateway/channels/slack/send", message: "appeared" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => {
        expect(
          runtime.log.mock.calls.some(([value]) => {
            const record = JSON.parse(String(value));
            return record.type === "log" && record.message === "appeared";
          }),
        ).toBe(true);
      });

      process.emit("SIGINT");
      await follow;
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-anchors when a file changes between reading and checkpointing", async () => {
    vi.useFakeTimers();
    try {
      const replacementPath = path.join(tempDir, "replacement.log");
      const oldPath = path.join(tempDir, "old.log");
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      await fs.writeFile(
        replacementPath,
        [
          logLine({ module: "gateway/channels/slack/send", message: "new-first" }),
          logLine({ module: "gateway/channels/slack/send", message: "new-second" }),
        ].join(""),
      );

      const realOpen = fs.open.bind(fs);
      let armRace = false;
      let armedOpenCount = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (armRace) {
          armedOpenCount += 1;
        }
        if (armRace && armedOpenCount === 4) {
          await fs.rename(logPath, oldPath);
          await fs.rename(replacementPath, logPath);
        }
        return realOpen(...args);
      });

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      armRace = true;
      await fs.appendFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "pending" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(5));
      expect(armedOpenCount).toBeGreaterThanOrEqual(4);

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["before", "new-first", "new-second"]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-anchors after a same-path rewrite preserves the file prefix during checkpointing", async () => {
    vi.useFakeTimers();
    try {
      const oldMessage = `${"x".repeat(200)}-old`;
      const newMessage = `${"x".repeat(200)}-new`;
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: oldMessage }),
      );

      const realOpen = fs.open.bind(fs);
      let armRace = false;
      let armedOpenCount = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (armRace) {
          armedOpenCount += 1;
        }
        if (armRace && armedOpenCount === 4) {
          await fs.writeFile(
            logPath,
            logLine({ module: "gateway/channels/slack/send", message: newMessage }),
          );
        }
        return realOpen(...args);
      });

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(2));

      armRace = true;
      await fs.appendFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "pending" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log.mock.calls.length).toBeGreaterThanOrEqual(4));
      expect(armedOpenCount).toBeGreaterThanOrEqual(4);

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual([oldMessage, newMessage]);
      expect(records.filter((record) => record.type === "notice")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues following when a file disappears during checkpointing", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      const realOpen = fs.open.bind(fs);
      let openCount = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        openCount += 1;
        if (openCount === 2) {
          throw Object.assign(new Error("rotated away"), { code: "ENOENT" });
        }
        return realOpen(...args);
      });

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log.mock.calls.length).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(openCount).toBeGreaterThanOrEqual(4));

      process.emit("SIGINT");
      await expect(follow).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues following when the tail open races a file rotation", async () => {
    vi.useFakeTimers();
    try {
      await fs.writeFile(
        logPath,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );
      const realOpen = fs.open.bind(fs);
      let openCount = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        openCount += 1;
        if (openCount === 4) {
          throw Object.assign(new Error("rotated away"), { code: "ENOENT" });
        }
        return realOpen(...args);
      });

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => expect(runtime.log.mock.calls.length).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(openCount).toBeGreaterThanOrEqual(4));

      process.emit("SIGINT");
      await expect(follow).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces a newly resolved rolling file after a checkpoint disappears", async () => {
    vi.useFakeTimers();
    try {
      const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
      const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
      setLoggerOverride({ file: configuredFile });
      await fs.writeFile(
        fallbackFile,
        logLine({ module: "gateway/channels/slack/send", message: "before" }),
      );

      const realOpen = fs.open.bind(fs);
      let openCount = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        openCount += 1;
        if (openCount === 2) {
          throw Object.assign(new Error("rotated away"), { code: "ENOENT" });
        }
        return realOpen(...args);
      });

      const follow = channelsLogsCommand(
        { channel: "slack", follow: true, interval: 10, json: true },
        runtime,
      );
      await vi.waitFor(() => {
        expect(openCount).toBeGreaterThanOrEqual(2);
        expect(
          runtime.log.mock.calls.some(([value]) => {
            const record = JSON.parse(String(value));
            return record.type === "log" && record.message === "before";
          }),
        ).toBe(true);
      });
      expect(
        runtime.log.mock.calls.some(([value]) => {
          const record = JSON.parse(String(value));
          return record.type === "meta" && record.file === fallbackFile;
        }),
      ).toBe(true);
      runtime.log.mockClear();

      await fs.rm(fallbackFile);
      await fs.writeFile(
        configuredFile,
        logLine({ module: "gateway/channels/slack/send", message: "after" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledTimes(3));

      process.emit("SIGINT");
      await follow;

      const records = runtime.log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(
        records.filter((record) => record.type === "meta").map((record) => record.file),
      ).toEqual([configuredFile]);
      expect(
        records.filter((record) => record.type === "log").map((record) => record.message),
      ).toEqual(["after"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid follow intervals", async () => {
    await expect(
      channelsLogsCommand({ follow: true, interval: "0", json: true }, runtime),
    ).rejects.toThrow("--interval must be a positive integer.");
  });

  it("rejects follow intervals beyond the timer limit", async () => {
    await expect(
      channelsLogsCommand({ follow: true, interval: "2147483648", json: true }, runtime),
    ).rejects.toThrow("--interval must be no greater than 2147483647 milliseconds.");
  });
});
