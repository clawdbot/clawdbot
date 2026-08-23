import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { getStatusSummary } from "./summary.js";

describe("getStatusSummary read-only session access", () => {
  const previousRegistry = getActivePluginRegistry();

  beforeEach(() => {
    const telegram = createOutboundTestPlugin({
      id: "telegram",
      outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
      messaging: {
        targetPrefixes: ["telegram"],
        inferTargetChatType: ({ to }) => {
          return /^(?:telegram:)?\d+$/.test(to) ? "direct" : undefined;
        },
      },
    });
    telegram.config = {
      ...telegram.config,
      resolveAllowFrom: ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [],
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
    );
  });

  afterAll(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it("does not create the heartbeat session database while checking its route", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-heartbeat-"));
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { session: { store: databasePath } },
      });

      expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(true);
      expect(fs.existsSync(databasePath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, "owner"])(
    "resolves the configured owner DM without writing session state for target %s",
    async (target) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-owner-"));
      const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

      try {
        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: {
            ...(target ? { agents: { defaults: { heartbeat: { target } } } } : {}),
            commands: { ownerAllowFrom: ["telegram:123"] },
            channels: { telegram: { allowFrom: ["123"] } },
            session: { store: databasePath },
          },
        });

        expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(false);
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
