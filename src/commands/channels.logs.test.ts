// Channels logs tests cover gateway log path resolution and channel log tailing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
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
  return JSON.stringify({
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
  });
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    file: string;
    channel: string;
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
      ].join("\n"),
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
  ])("excludes a shadow $label while preserving an exact channel match", async (fixture) => {
    await fs.writeFile(
      logPath,
      [
        logLine({ ...fixture.shadow, message: "shadow" }),
        logLine({ ...fixture.match, message: "match" }),
      ].join("\n"),
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
      ].join("\n"),
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
    await fs.writeFile(logPath, lines.join("\n"));

    await channelsLogsCommand({ channel: "slack", lines: 2000, json: true }, runtime);

    expect(readJsonPayload().lines.map((line) => line.message)).toEqual([
      "first match",
      "second match",
    ]);
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
