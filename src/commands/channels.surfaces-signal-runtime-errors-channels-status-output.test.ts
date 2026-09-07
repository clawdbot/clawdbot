// Channels status error-surface tests cover Signal runtime errors in channel status output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectStatusIssuesFromLastError } from "../plugin-sdk/status-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.runtime.js";

const now = 1_700_000_000_000;

const signalPlugin = {
  ...createChannelTestPluginBase({ id: "signal" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("signal", accounts),
  },
};

const imessagePlugin = {
  ...createChannelTestPluginBase({ id: "imessage" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("imessage", accounts),
  },
};

describe("channels command", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("guides operators when no channels are configured", () => {
    const lines = formatGatewayChannelsStatusLines({ channelAccounts: {} });

    expect(lines).toContain(
      "- no configured chat channels (run `openclaw channels list --all` to see installable channels)",
    );
  });

  it("surfaces Signal runtime errors in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/signal/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces iMessage runtime errors in channels status output", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: imessagePlugin,
        },
      ]),
    );
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        imessage: "iMessage",
      },
      channelAccounts: {
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imsg permission denied",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/imessage/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces degraded gateway event-loop health in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      eventLoop: {
        degraded: true,
        degradedSinceMs: 180_000,
        reasons: ["event_loop_delay", "cpu"],
        intervalMs: 62_000,
        delayP99Ms: 61_000,
        delayMaxMs: 62_000,
        utilization: 1,
        cpuCoreRatio: 1,
      },
      channelLabels: {},
      channelAccounts: {},
    });

    expect(lines.join("\n")).toMatch(/Gateway event loop degraded/);
    expect(lines.join("\n")).toMatch(/for 3m \(p99 61000ms\)/);
    expect(lines.join("\n")).toMatch(/eventLoopDelayMaxMs=62000/);
  });

  it("surfaces top-level partial status warnings", () => {
    const lines = formatGatewayChannelsStatusLines({
      partial: true,
      warnings: ["whatsapp:default status failed: snapshot failed"],
      channelLabels: {},
      channelAccounts: {},
    });

    expect(lines.join("\n")).toMatch(/Channel status is partial/);
    expect(lines.join("\n")).toContain("whatsapp:default status failed: snapshot failed");
  });

  it("renders Gateway policy diagnostics and recovery without calling status partial", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: { signal: [{ accountId: "default", configured: true, running: true }] },
      statusIssues: [
        {
          channel: "signal",
          accountId: "default",
          kind: "config",
          message: "Channel configuration reload is deferred while active work finishes.",
          fix: "Wait for active work to finish, then refresh channel status.",
        },
      ],
    }).join("\n");
    expect(lines).toContain("running");
    expect(lines).toContain("configuration reload is deferred");
    expect(lines).toContain("Wait for active work to finish");
    expect(lines).not.toContain("status is partial");
  });

  it("surfaces transport liveness timestamps in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: true,
            lastTransportActivityAt: now - 2 * 60_000,
          },
        ],
      },
    });

    expect(lines.join("\n")).toContain("transport:");
  });
});
