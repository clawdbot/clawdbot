import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { disablePluginAfterUpdateFailure, migratePluginConfigId } from "./update-config.js";

describe("plugin update config helpers", () => {
  it("migrates plugin ids in authored agents.entries memory slots without touching list aliases", () => {
    const config = {
      plugins: {
        allow: ["voice-call"],
        deny: ["voice-call"],
        slots: { "memory.recall": "voice-call" },
        entries: { "voice-call": { enabled: true } },
      },
      agents: {
        entries: {
          research: {
            plugins: {
              slots: {
                "memory.recall": "voice-call",
                "memory.compaction": "other-memory",
              },
            },
          },
        },
        list: [
          {
            id: "research",
            plugins: {
              slots: {
                "memory.recall": "voice-call",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = migratePluginConfigId(config, "voice-call", "@openclaw/voice-call");

    expect(result.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.plugins?.slots?.["memory.recall"]).toBe("@openclaw/voice-call");
    expect(result.plugins?.entries?.["@openclaw/voice-call"]).toEqual({ enabled: true });
    expect(result.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.agents?.entries?.research?.plugins?.slots).toEqual({
      "memory.recall": "@openclaw/voice-call",
      "memory.compaction": "other-memory",
    });
    expect(result.agents?.list?.[0]?.plugins?.slots?.["memory.recall"]).toBe("voice-call");
  });

  it("resets update-failure memory slots in authored agents.entries", () => {
    const config = {
      plugins: {
        allow: ["agent-memory"],
        deny: ["agent-memory"],
        slots: { "memory.recall": "agent-memory" },
        entries: { "agent-memory": { enabled: true } },
      },
      agents: {
        entries: {
          research: {
            plugins: {
              slots: {
                "memory.recall": "agent-memory",
                "memory.capture": "other-memory",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = disablePluginAfterUpdateFailure(config, "agent-memory");

    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.deny).toBeUndefined();
    expect(result.plugins?.slots?.["memory.recall"]).toBe("memory-core");
    expect(result.plugins?.entries?.["agent-memory"]?.enabled).toBe(false);
    expect(result.agents?.entries?.research?.plugins?.slots).toEqual({
      "memory.recall": "memory-core",
      "memory.capture": "other-memory",
    });
  });
});
