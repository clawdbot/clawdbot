import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
  selectSystemEventsConsumedByHeartbeat,
} from "./heartbeat-runner-prompt.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

describe("heartbeat mixed event ownership", () => {
  it.each([
    {
      name: "exec wake",
      source: "exec-event" as const,
      reason: "exec-event",
      specialized: "Exec failed (backup, code 1) :: backup failed",
      expectedSpecialized: "backup failed",
    },
    {
      name: "cron wake",
      source: "cron" as const,
      reason: "cron:overnight-report",
      specialized: "Reminder: Send the overnight report",
      expectedSpecialized: "Reminder: Send the overnight report",
    },
  ])("composes and consumes generic events with a $name", async (testCase) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("Gateway restart ok", { sessionKey });
      enqueueSystemEvent(testCase.specialized, {
        sessionKey,
        ...(testCase.source === "cron" ? { contextKey: "cron:overnight-report" } : {}),
      });

      const preflight = await resolveHeartbeatPreflight({
        cfg,
        agentId: "main",
        heartbeat: cfg.agents?.defaults?.heartbeat,
        source: testCase.source,
        reason: testCase.reason,
      });
      const resolution = resolveHeartbeatRunPrompt({
        cfg,
        heartbeat: cfg.agents?.defaults?.heartbeat,
        preflight,
        canRelayToUser: true,
        startedAt: Date.now(),
        scheduledTasks: [],
        useHeartbeatResponseTool: false,
      });
      const consumed = selectSystemEventsConsumedByHeartbeat({
        preflight,
        hasExecCompletion: resolution.hasExecCompletion,
        hasCronEvents: resolution.hasCronEvents,
        hasGenericEvents: resolution.hasGenericEvents,
        handledSystemEvents: resolution.handledSystemEvents,
      });

      expect(resolution.prompt).toContain("Gateway restart ok");
      expect(resolution.prompt).toContain(testCase.expectedSpecialized);
      expect(
        resolution.genericEvents.map((event) => event.text),
        "the composed prompt owns generic rendering, so admission gets nothing to re-render",
      ).toEqual([]);
      expect(consumed.map((event) => event.text)).toEqual([
        "Gateway restart ok",
        testCase.specialized,
      ]);
      expect(peekSystemEvents(sessionKey)).toEqual(["Gateway restart ok", testCase.specialized]);
    });
  });

  it("keeps periodic wakes handing generic events to reply admission", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("Gateway restart ok", { sessionKey });

      const preflight = await resolveHeartbeatPreflight({
        cfg,
        agentId: "main",
        heartbeat: cfg.agents?.defaults?.heartbeat,
        source: "interval",
        reason: "interval",
      });
      const resolution = resolveHeartbeatRunPrompt({
        cfg,
        heartbeat: cfg.agents?.defaults?.heartbeat,
        preflight,
        canRelayToUser: true,
        startedAt: Date.now(),
        scheduledTasks: [],
        useHeartbeatResponseTool: false,
      });
      const consumed = selectSystemEventsConsumedByHeartbeat({
        preflight,
        hasExecCompletion: resolution.hasExecCompletion,
        hasCronEvents: resolution.hasCronEvents,
        hasGenericEvents: resolution.hasGenericEvents,
        handledSystemEvents: resolution.handledSystemEvents,
      });

      expect(preflight.shouldInspectPendingEvents).toBe(false);
      expect(resolution.prompt).not.toContain("Gateway restart ok");
      expect(resolution.genericEvents.map((event) => event.text)).toEqual(["Gateway restart ok"]);
      expect(consumed).toEqual([]);
      expect(peekSystemEvents(sessionKey)).toEqual(["Gateway restart ok"]);
    });
  });

  it("leaves generic events omitted by the prompt budget queued", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const oversizedEvent = `Gateway startup report ${"x".repeat(8_100)}`;
      const omittedEvent = "Gateway restart ok";
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent(oversizedEvent, { sessionKey });
      enqueueSystemEvent(omittedEvent, { sessionKey });

      const preflight = await resolveHeartbeatPreflight({
        cfg,
        agentId: "main",
        heartbeat: cfg.agents?.defaults?.heartbeat,
        source: "hook",
        reason: "gateway-restart",
      });
      const resolution = resolveHeartbeatRunPrompt({
        cfg,
        heartbeat: cfg.agents?.defaults?.heartbeat,
        preflight,
        canRelayToUser: true,
        startedAt: Date.now(),
        scheduledTasks: [],
        useHeartbeatResponseTool: false,
      });
      const consumed = selectSystemEventsConsumedByHeartbeat({
        preflight,
        hasExecCompletion: resolution.hasExecCompletion,
        hasCronEvents: resolution.hasCronEvents,
        hasGenericEvents: resolution.hasGenericEvents,
        handledSystemEvents: resolution.handledSystemEvents,
      });

      expect(resolution.prompt).toContain("[truncated]");
      expect(resolution.prompt).not.toContain(omittedEvent);
      expect(consumed.map((event) => event.text)).toEqual([oversizedEvent]);
      expect(resolution.partialEventRemainders).toHaveLength(1);
      expect(resolution.partialEventRemainders[0]?.event.text).toBe(oversizedEvent);
      expect(resolution.partialEventRemainders[0]?.remainder).toMatch(/^x+$/);

      // Mirror terminal consumption: re-queue the truncation-hidden remainder,
      // then consume the surfaced originals.
      for (const { event, remainder } of resolution.partialEventRemainders) {
        enqueueSystemEvent(remainder, {
          sessionKey,
          ...(event.contextKey ? { contextKey: event.contextKey } : {}),
        });
      }
      consumeSelectedSystemEventEntries(sessionKey, consumed);
      const queued = peekSystemEvents(sessionKey);
      expect(queued[0]).toBe(omittedEvent);
      expect(queued.length).toBe(2);
      expect(queued[1]).toMatch(/^x+$/);
      expect(queued[1]!.length).toBeGreaterThan(50);
    });
  });
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});
