import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("talk config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("can load an unpinned runtime config without replacing the process snapshot", async () => {
    await withTempHomeConfig({ gateway: { port: 19002 } }, async () => {
      const unpinned = getRuntimeConfig({ skipPluginValidation: true, pin: false });

      expect(unpinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBeNull();

      const pinned = getRuntimeConfig();

      expect(pinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBe(pinned);
    });
  });

  async function expectInvalidTalkConfig(config: unknown, messagePattern: RegExp) {
    await withTempHomeConfig(config, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let thrown: unknown;
      try {
        getRuntimeConfig();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
      expect((thrown as Error).message).toMatch(messagePattern);
      expect(consoleSpy).toHaveBeenCalled();
    });
  }

  it.each([
    ["boolean", true],
    ["string", "1500"],
    ["float", 1500.5],
  ])("rejects %s talk.silenceTimeoutMs during config load", async (_label, value) => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          silenceTimeoutMs: value,
        },
      },
      /silenceTimeoutMs|talk/i,
    );
  });

  it("rejects talk.provider when it does not match talk.providers during config load", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          provider: "acme",
          providers: {
            elevenlabs: {
              voiceId: "voice-123",
            },
          },
        },
      },
      /talk\.provider|talk\.providers|acme/i,
    );
  });

  it("rejects multi-provider talk config without talk.provider during config load", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          providers: {
            acme: {
              voiceId: "voice-acme",
            },
            elevenlabs: {
              voiceId: "voice-eleven",
            },
          },
        },
      },
      /talk\.provider|required/i,
    );
  });
});
