import { describe, expect, it } from "vitest";
import { checkContextRecoveryNeeded, resolveContextRecoverySettings } from "./context-recovery.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

describe("context-recovery", () => {
  describe("resolveContextRecoverySettings", () => {
    it("returns disabled when not configured", () => {
      const cfg = {} as MoltbotConfig;
      const settings = resolveContextRecoverySettings(cfg);
      expect(settings.enabled).toBe(false);
      expect(settings.messages).toBe(0);
    });

    it("returns disabled when messages is 0", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 0 },
            },
          },
        },
      } as MoltbotConfig;
      const settings = resolveContextRecoverySettings(cfg);
      expect(settings.enabled).toBe(false);
      expect(settings.messages).toBe(0);
    });

    it("returns enabled with correct message count", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 10 },
            },
          },
        },
      } as MoltbotConfig;
      const settings = resolveContextRecoverySettings(cfg);
      expect(settings.enabled).toBe(true);
      expect(settings.messages).toBe(10);
    });

    it("caps message count at 50", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 100 },
            },
          },
        },
      } as MoltbotConfig;
      const settings = resolveContextRecoverySettings(cfg);
      expect(settings.enabled).toBe(true);
      expect(settings.messages).toBe(50);
    });
  });

  describe("checkContextRecoveryNeeded", () => {
    it("returns not needed when disabled", () => {
      const cfg = {} as MoltbotConfig;
      const sessionEntry = {
        sessionId: "test",
        updatedAt: Date.now(),
        compactionCount: 5,
      } as SessionEntry;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry });
      expect(result.needed).toBe(false);
    });

    it("returns not needed when no session entry", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 10 },
            },
          },
        },
      } as MoltbotConfig;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry: undefined });
      expect(result.needed).toBe(false);
    });

    it("returns not needed when compaction count is 0", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 10 },
            },
          },
        },
      } as MoltbotConfig;
      const sessionEntry = {
        sessionId: "test",
        updatedAt: Date.now(),
        compactionCount: 0,
      } as SessionEntry;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry });
      expect(result.needed).toBe(false);
    });

    it("returns not needed when already recovered for current compaction", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 10 },
            },
          },
        },
      } as MoltbotConfig;
      const sessionEntry = {
        sessionId: "test",
        updatedAt: Date.now(),
        compactionCount: 3,
        lastContextRecoveryCompactionCount: 3,
      } as SessionEntry;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry });
      expect(result.needed).toBe(false);
    });

    it("returns needed when compaction count exceeds last recovery", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 10 },
            },
          },
        },
      } as MoltbotConfig;
      const sessionEntry = {
        sessionId: "test",
        updatedAt: Date.now(),
        compactionCount: 3,
        lastContextRecoveryCompactionCount: 2,
      } as SessionEntry;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry });
      expect(result.needed).toBe(true);
      expect(result.messageCount).toBe(10);
      expect(result.compactionCount).toBe(3);
    });

    it("returns needed on first compaction when never recovered", () => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              contextRecovery: { messages: 5 },
            },
          },
        },
      } as MoltbotConfig;
      const sessionEntry = {
        sessionId: "test",
        updatedAt: Date.now(),
        compactionCount: 1,
      } as SessionEntry;

      const result = checkContextRecoveryNeeded({ cfg, sessionEntry });
      expect(result.needed).toBe(true);
      expect(result.messageCount).toBe(5);
      expect(result.compactionCount).toBe(1);
    });
  });
});
