import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  getChannelActivity,
  recordChannelActivity,
  resetChannelActivityForTest,
} from "./channel-activity.js";
import { createDedupeCache } from "./dedupe.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import {
  loadVoiceWakeRoutingConfig,
  normalizeVoiceWakeTriggerWord,
  resolveVoiceWakeRouteByTrigger,
  setVoiceWakeRoutingConfig,
} from "./voicewake-routing.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

const missingStoreDefaultCases = [
  {
    name: "voicewake store",
    prefix: "openclaw-voicewake-",
    assertDefaults: async (baseDir: string) => {
      const cfg = await loadVoiceWakeConfig(baseDir);
      expect(cfg.triggers).toEqual(defaultVoiceWakeTriggers());
      expect(cfg.updatedAtMs).toBe(0);
    },
  },
  {
    name: "voicewake routing store",
    prefix: "openclaw-voicewake-routing-",
    assertDefaults: async (baseDir: string) => {
      const cfg = await loadVoiceWakeRoutingConfig(baseDir);
      expect(cfg.version).toBe(1);
      expect(cfg.defaultTarget).toEqual({ mode: "current" });
      expect(cfg.routes).toEqual([]);
      expect(cfg.updatedAtMs).toBe(0);
    },
  },
];

describe("infra store", () => {
  describe("state migrations fs", () => {
    it("treats array session stores as invalid", async () => {
      await withTempDir("openclaw-session-store-", async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await fs.writeFile(storePath, "[]", "utf-8");

        const result = readSessionStoreJson5(storePath);
        expect(result.ok).toBe(false);
        expect(result.store).toStrictEqual({});
      });
    });

    it("parses JSON5 object session stores", async () => {
      await withTempDir("openclaw-session-store-", async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await fs.writeFile(
          storePath,
          "{\n  // comment allowed in JSON5\n  main: { sessionId: 's1', updatedAt: 123 },\n}\n",
          "utf-8",
        );

        const result = readSessionStoreJson5(storePath);
        expect(result.ok).toBe(true);
        expect(result.store.main?.sessionId).toBe("s1");
        expect(result.store.main?.updatedAt).toBe(123);
      });
    });
  });

  describe("missing store defaults", () => {
    it.each(missingStoreDefaultCases)(
      "$name returns defaults when missing",
      async ({ assertDefaults, prefix }) => {
        await withTempDir(prefix, assertDefaults);
      },
    );
  });

  describe("voicewake store", () => {
    it("sanitizes and persists triggers", async () => {
      await withTempDir("openclaw-voicewake-", async (baseDir) => {
        const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
        expect(saved.triggers).toEqual(["hi", "there"]);
        expect(saved.updatedAtMs).toBeGreaterThan(0);

        const loaded = await loadVoiceWakeConfig(baseDir);
        expect(loaded.triggers).toEqual(["hi", "there"]);
        expect(loaded.updatedAtMs).toBeGreaterThan(0);
      });
    });

    it("falls back to defaults when triggers empty", async () => {
      await withTempDir("openclaw-voicewake-", async (baseDir) => {
        const saved = await setVoiceWakeTriggers(["", "   "], baseDir);
        expect(saved.triggers).toEqual(defaultVoiceWakeTriggers());
      });
    });

    it("sanitizes malformed persisted config values", async () => {
      await withTempDir("openclaw-voicewake-", async (baseDir) => {
        await fs.mkdir(path.join(baseDir, "settings"), { recursive: true });
        await fs.writeFile(
          path.join(baseDir, "settings", "voicewake.json"),
          JSON.stringify({
            triggers: ["  wake ", "", 42, null],
            updatedAtMs: -1,
          }),
          "utf-8",
        );

        const loaded = await loadVoiceWakeConfig(baseDir);
        expect(loaded.triggers).toEqual(["wake"]);
        expect(loaded.updatedAtMs).toBe(0);
      });
    });
  });

  describe("voicewake routing store", () => {
    it("normalizes and persists routing config", async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voicewake-routing-"));
      const saved = await setVoiceWakeRoutingConfig(
        {
          defaultTarget: { mode: "current" },
          routes: [
            { trigger: "  Hello   Bot  ", target: { agentId: "main" } },
            { trigger: "", target: { sessionKey: "agent:main:main" } },
          ],
        },
        baseDir,
      );
      expect(saved.routes).toEqual([{ trigger: "hello bot", target: { agentId: "main" } }]);
      expect(saved.updatedAtMs).toBeGreaterThan(0);

      const loaded = await loadVoiceWakeRoutingConfig(baseDir);
      expect(loaded.routes).toEqual([{ trigger: "hello bot", target: { agentId: "main" } }]);
    });

    it("resolves routes by normalized trigger", () => {
      const result = resolveVoiceWakeRouteByTrigger({
        trigger: "  HELLO   BOT ",
        config: {
          version: 1,
          defaultTarget: { mode: "current" },
          routes: [{ trigger: "hello bot", target: { sessionKey: "agent:main:main" } }],
          updatedAtMs: 0,
        },
      });
      expect(result).toEqual({ sessionKey: "agent:main:main" });
      expect(normalizeVoiceWakeTriggerWord("  X  Y ")).toBe("x y");
    });
  });

  describe("diagnostic-events", () => {
    it("emits monotonic seq", () => {
      resetDiagnosticEventsForTest();
      const seqs: number[] = [];
      const stop = onDiagnosticEvent((evt) => seqs.push(evt.seq));

      emitDiagnosticEvent({
        type: "model.usage",
        usage: { total: 1 },
      });
      emitDiagnosticEvent({
        type: "model.usage",
        usage: { total: 2 },
      });

      stop();

      expect(seqs).toEqual([1, 2]);
    });

    it("emits message-flow events", () => {
      resetDiagnosticEventsForTest();
      const types: string[] = [];
      const stop = onDiagnosticEvent((evt) => types.push(evt.type));

      emitDiagnosticEvent({
        type: "webhook.received",
        channel: "telegram",
        updateType: "telegram-post",
      });
      emitDiagnosticEvent({
        type: "message.queued",
        channel: "telegram",
        source: "telegram",
        queueDepth: 1,
      });
      emitDiagnosticEvent({
        type: "session.state",
        state: "processing",
        reason: "run_started",
      });

      stop();

      expect(types).toEqual(["webhook.received", "message.queued", "session.state"]);
    });
  });

  describe("channel activity", () => {
    beforeEach(() => {
      resetChannelActivityForTest();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records inbound/outbound separately", () => {
      recordChannelActivity({ channel: "telegram", direction: "inbound" });
      vi.advanceTimersByTime(1000);
      recordChannelActivity({ channel: "telegram", direction: "outbound" });
      const res = getChannelActivity({ channel: "telegram" });
      expect(res.inboundAt).toBe(1767830400000);
      expect(res.outboundAt).toBe(1767830401000);
    });

    it("isolates accounts", () => {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: "a",
        direction: "inbound",
        at: 1,
      });
      recordChannelActivity({
        channel: "whatsapp",
        accountId: "b",
        direction: "inbound",
        at: 2,
      });
      expect(getChannelActivity({ channel: "whatsapp", accountId: "a" })).toEqual({
        inboundAt: 1,
        outboundAt: null,
      });
      expect(getChannelActivity({ channel: "whatsapp", accountId: "b" })).toEqual({
        inboundAt: 2,
        outboundAt: null,
      });
    });
  });

  describe("createDedupeCache", () => {
    it("marks duplicates within TTL", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("a", 500)).toBe(true);
    });

    it("expires entries after TTL", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("a", 1501)).toBe(false);
    });

    it("evicts oldest entries when over max size", () => {
      const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("b", 200)).toBe(false);
      expect(cache.check("c", 300)).toBe(false);
      expect(cache.check("a", 400)).toBe(false);
    });

    it("prunes expired entries even when refreshed keys are older in insertion order", () => {
      const cache = createDedupeCache({ ttlMs: 100, maxSize: 10 });
      expect(cache.check("a", 0)).toBe(false);
      expect(cache.check("b", 50)).toBe(false);
      expect(cache.check("a", 120)).toBe(false);
      expect(cache.check("c", 200)).toBe(false);
      expect(cache.size()).toBe(2);
    });

    it("supports non-mutating existence checks via peek()", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.peek("a", 100)).toBe(false);
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.peek("a", 200)).toBe(true);
      expect(cache.peek("a", 1201)).toBe(false);
    });
  });
});
