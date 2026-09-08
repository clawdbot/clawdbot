import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempTelegramHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  resetSystemEventsForTest();
});

it.each(
  [
    {
      name: "first isolated run without a base",
      baseExists: false,
      isolatedSession: true,
      baseKey: "agent:main:main",
      queueKey: "agent:main:main",
      runKey: "agent:main:main:heartbeat",
    },
    {
      name: "first isolated run with an existing base",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:main:main",
      queueKey: "agent:main:main",
      runKey: "agent:main:main:heartbeat",
    },
    {
      name: "shared run",
      baseExists: true,
      isolatedSession: false,
      baseKey: "agent:main:main",
      queueKey: "agent:main:main",
      runKey: "agent:main:main",
    },
    {
      name: "canonical isolated re-entry",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:main:main",
      queueKey: "agent:main:main:heartbeat",
      runKey: "agent:main:main:heartbeat",
    },
    {
      name: "legacy deep isolated re-entry",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:main:main",
      queueKey: "agent:main:main:heartbeat:heartbeat",
      runKey: "agent:main:main:heartbeat",
    },
    {
      name: "configured base with a real heartbeat suffix",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:main:alerts:heartbeat",
      queueKey: "agent:main:alerts:heartbeat",
      runKey: "agent:main:alerts:heartbeat:heartbeat",
    },
    {
      name: "real suffix base through isolated re-entry",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:main:alerts:heartbeat",
      queueKey: "agent:main:alerts:heartbeat:heartbeat",
      runKey: "agent:main:alerts:heartbeat:heartbeat",
    },
    {
      name: "secondary agent in a flat store without a base",
      agentId: "ops",
      baseExists: false,
      isolatedSession: true,
      baseKey: "agent:ops:main",
      queueKey: "agent:ops:main",
      runKey: "agent:ops:main:heartbeat",
    },
    {
      name: "secondary legacy re-entry in a flat store",
      agentId: "ops",
      baseExists: true,
      isolatedSession: true,
      baseKey: "agent:ops:main",
      queueKey: "agent:ops:main:heartbeat:heartbeat",
      runKey: "agent:ops:main:heartbeat",
    },
    {
      name: "secondary shared global session in a flat store",
      agentId: "ops",
      baseExists: true,
      isolatedSession: false,
      baseKey: "global",
      queueKey: "global",
      runKey: "global",
    },
    ...["flat", "default", "templated"].map((storeLayout) => ({
      name: `secondary global session in a ${storeLayout} store`,
      agentId: "ops",
      storeLayout,
      baseExists: true,
      isolatedSession: true,
      baseKey: "global",
      queueKey: "global",
      runKey: "agent:ops:global:heartbeat",
    })),
  ].map((testCase) => Object.assign({ agentId: "main", storeLayout: "flat" }, testCase)),
)(
  "retains a silent outcome for the next base-session user: $name",
  async ({
    agentId,
    storeLayout,
    baseExists,
    isolatedSession,
    baseKey: sessionKey,
    queueKey,
    runKey,
  }) => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath: flatStorePath, replySpy }) => {
        const globalSession = sessionKey === "global";
        const recipient = globalSession ? "-10012345" : "12345";
        const configuredStore =
          storeLayout === "default"
            ? undefined
            : storeLayout === "templated"
              ? path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json")
              : flatStorePath;
        const storePath = resolveSessionStorePathCore(configuredStore, { agentId });
        const mainStorePath = resolveSessionStorePathCore(configuredStore, { agentId: "main" });
        const scope = { agentId, storePath, sessionKey };
        const readEntry = (key: string) =>
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: key })?.entry;
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {}, ...(agentId === "ops" ? { ops: {} } : {}) },
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                isolatedSession,
                session: sessionKey,
                target: globalSession ? "last" : "telegram",
                ...(globalSession ? {} : { to: recipient }),
              },
            },
          },
          messages: { visibleReplies: "message_tool" },
          channels: { telegram: { enabled: true, botToken: "test", allowFrom: ["*"] } },
          session: {
            ...(configuredStore ? { store: configuredStore } : {}),
            ...(globalSession ? { scope: "global" } : {}),
          },
        };
        if (baseExists) {
          await replaceSessionEntry(scope, {
            sessionId: "existing-user-session",
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: recipient },
            }),
          });
        } else {
          expect(readEntry(sessionKey)).toBeUndefined();
        }
        if (globalSession) {
          await replaceSessionEntry(
            { agentId: "main", storePath: mainStorePath, sessionKey: "global" },
            {
              sessionId: "unrelated-main-global",
              updatedAt: Date.now(),
              delivery: normalizeSessionDeliveryState({
                context: { channel: "telegram", to: "-10099999" },
              }),
            },
          );
        }
        const initialMainEntries = listSessionEntriesReadOnly({
          agentId: "main",
          storePath: mainStorePath,
        });
        const reentry = queueKey !== sessionKey;
        if (reentry) {
          await replaceSessionEntry(
            { ...scope, sessionKey: queueKey },
            {
              sessionId: "previous-isolated-session",
              updatedAt: Date.now(),
              heartbeatIsolatedBaseSessionKey: sessionKey,
            },
          );
          enqueueSystemEvent("Cron: selected isolated work completed", {
            sessionKey: queueKey,
            contextKey: "cron:selected-outcome",
          });
        }
        const summary = `Quiet work completed in ${runKey}`;
        replySpy.mockImplementation(async () => {
          if (reentry) {
            enqueueSystemEvent("Cron: later isolated work completed", {
              sessionKey: queueKey,
              contextKey: "cron:later-outcome",
            });
          }
          return createHeartbeatToolResponsePayload({ outcome: "done", notify: false, summary });
        });
        const sendTelegram = vi.fn();
        const result = await runHeartbeatOnce({
          cfg,
          agentId,
          sessionKey: queueKey,
          deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, getQueueSize: () => 0 },
        });
        expect(result, JSON.stringify(result)).toMatchObject({ status: "ran" });
        expect(sendTelegram).not.toHaveBeenCalled();
        const store = Object.fromEntries(
          listSessionEntriesReadOnly({ agentId, storePath }).map(({ sessionKey: key, entry }) => [
            key,
            entry,
          ]),
        );
        expect(store[sessionKey]?.sessionId).toBeTruthy();
        if (isolatedSession) {
          expect(store[sessionKey]?.sessionId).not.toBe(store[runKey]?.sessionId);
          expect(store[runKey]?.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
        }
        if (reentry) {
          expect(peekSystemEventEntries(queueKey).map((event) => event.text)).toEqual([
            "Cron: later isolated work completed",
          ]);
          if (queueKey !== runKey) {
            expect(store[queueKey]).toBeUndefined();
          }
        }
        if (baseExists) {
          expect(store[sessionKey]?.sessionId).toBe("existing-user-session");
        }
        const params = { ...scope, runId: "first-user-run" };
        expect(claimHeartbeatOutcomeForRun(params)).toMatchObject({
          sessionKey,
          runSessionKey: runKey,
          summary,
        });
        expect(claimHeartbeatOutcomeForRun(params)).toBeDefined();
        expect(
          claimHeartbeatOutcomeForRun({ ...params, runId: "second-user-run" }),
        ).toBeUndefined();
        if (agentId === "ops") {
          const physicalPath =
            storeLayout === "flat"
              ? path.join(tmpDir, "openclaw-agent.ops.sqlite")
              : path.join(
                  tmpDir,
                  ...(storeLayout === "default" ? ["state"] : []),
                  "agents",
                  "ops",
                  "agent",
                  "openclaw-agent.sqlite",
                );
          for (const key of [sessionKey, runKey]) {
            expect(
              loadExactSessionEntryReadOnly({ agentId, storePath: physicalPath, sessionKey: key })
                ?.entry?.sessionId,
            ).toBe(store[key]?.sessionId);
          }
          if (globalSession) {
            const alert = "Scoped monitor alert";
            replySpy.mockResolvedValue(
              createHeartbeatToolResponsePayload({
                outcome: "needs_attention",
                notify: true,
                summary: alert,
                notificationText: alert,
              }),
            );
            sendTelegram.mockResolvedValue({ messageId: "scoped-alert" });
            for (let attempt = 0; attempt < 2; attempt++) {
              expect(
                await runHeartbeatOnce({
                  cfg,
                  agentId,
                  deps: {
                    getReplyFromConfig: replySpy,
                    telegram: sendTelegram,
                    getQueueSize: () => 0,
                  },
                }),
              ).toMatchObject({ status: "ran" });
            }
            expect(sendTelegram).toHaveBeenCalledTimes(1);
            expect(sendTelegram.mock.calls[0]?.slice(0, 2)).toEqual([recipient, alert]);
            expect(readEntry(sessionKey)).toMatchObject({
              sessionId: "existing-user-session",
              updatedAt: store[sessionKey]?.updatedAt,
              lastHeartbeatText: alert,
            });
          }
          expect(listSessionEntriesReadOnly({ agentId: "main", storePath: mainStorePath })).toEqual(
            initialMainEntries,
          );
        }
      },
    );
  },
);
