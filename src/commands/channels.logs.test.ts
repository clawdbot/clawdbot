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
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockClear();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    const fixtureCredential = "synthetic-channel-log-credential-1234567890";
    await fs.writeFile(
      logPath,
      logLine({
        module: "gateway/channels/slack/send",
        message: `X-OpenClaw-Token: ${fixtureCredential}`,
      }),
    );

    await channelsLogsCommand({ channel: "slack" }, runtime);

    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("2026-04-25T12:00:00.000Z info");
    expect(output).toContain("X-OpenClaw-Token: synthe…7890");
    expect(output).not.toContain(fixtureCredential);
  });

  it("redacts credential-bearing channel lines in JSON output", async () => {
    const fixtureCredential = "synthetic-channel-log-credential-1234567890";
    await fs.writeFile(
      logPath,
      logLine({
        module: "gateway/channels/slack/send",
        message: `X-OpenClaw-Token: ${fixtureCredential}`,
      }),
    );

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.lines[0]?.message).toBe("X-OpenClaw-Token: synthe…7890");
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
