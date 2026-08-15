import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
/**
 * Session message event indexing and broadcast tests.
 */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { RawData } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { SubagentLifecycleController } from "../agents/subagents/registry/subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as secureRandom from "../infra/secure-random.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import { ensureProfileForEmail, setAvatar, setDisplayName } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import type { WorkerTranscriptCommitStore } from "./worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./worker-environments/transcript-commit.js";

installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const cleanupTestStates: OpenClawTestState[] = [];
const SETUP_RPC_TIMEOUT_MS = 30_000;
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let subscribedOperatorWs:
  | Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>
  | undefined;

// No explicit hook timeout: the suite harness cold-imports the full gateway
// server graph, which can legitimately exceed 60s on contended CI runners.
// Sibling gateway suites rely on the shared project hookTimeout (120s, 180s on
// Windows) for the same boot; tightening it here caused flaky hook timeouts.
beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  subscribedOperatorWs = await harness.openWs();
  await connectOk(subscribedOperatorWs, {
    scopes: ["operator.read"],
    timeoutMs: SETUP_RPC_TIMEOUT_MS,
  });
  await rpcReq(subscribedOperatorWs, "sessions.subscribe", undefined, SETUP_RPC_TIMEOUT_MS);
});

afterAll(async () => {
  subscribedOperatorWs?.close();
  if (harness) {
    await harness.close();
  }
});

afterEach(async () => {
  for (const state of cleanupTestStates.splice(0).toReversed()) {
    await state.cleanup();
  }
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function withOperatorSessionSubscriber<T>(
  run: (ws: NonNullable<typeof subscribedOperatorWs>) => Promise<T>,
) {
  if (!subscribedOperatorWs) {
    throw new Error("subscribed operator websocket is not ready");
  }
  return await run(subscribedOperatorWs);
}

function waitForSessionMessageEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
  timeoutMs?: number,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
    timeoutMs,
  );
}

function waitForSessionObserverEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  runId: string,
  timeoutMs?: number,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.observer" &&
      (message.payload as { runId?: string } | undefined)?.runId === runId,
    timeoutMs,
  );
}

function waitForSessionsChangedMessagePhase(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "sessions.changed" &&
      (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
        "message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

async function emitTranscriptUpdateAndCollectMessageEvent(params: {
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>;
  sessionKey: string;
  sessionFile: string;
  message: Record<string, unknown>;
  messageId: string;
  agentId?: string;
  messageSeq?: number;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);

  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    messageId: params.messageId,
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
  });

  const messageEvent = await messageEventPromise;
  return { messageEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: (timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  const received = params.watch(timeoutMs).then(
    () => true,
    () => false,
  );
  await params.action?.();
  await expect(received).resolves.toBe(false);
}

const requireRecord = createRequireRecord("object", "expected-label-object");

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function withMockedDateNow<T>(now: number, run: () => T): T {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

function attributedMessageProjection(value: unknown) {
  const message = requireRecord(value, "attributed message");
  const metadata = requireRecord(message["__openclaw"], "attributed message metadata");
  return {
    role: message.role,
    content: message.content,
    __openclaw: {
      senderId: metadata.senderId,
      senderName: metadata.senderName,
      senderUsername: metadata.senderUsername,
      senderProfileAvatarUrl: metadata.senderProfileAvatarUrl,
    },
  };
}

function currentProfileAvatarUrl(profileId: string): string {
  const display = resolveCurrentUserProfileDisplay(profileId);
  expect(display.kind).toBe("resolved");
  if (display.kind !== "resolved") {
    throw new Error("expected a resolved current profile display");
  }
  return display.avatarUrl;
}

describe("session.message websocket events", () => {
  test("publishes only the explicit per-connection viewer replace-set", async () => {
    const observerWs = await harness.openWs();
    const watchedWs = await harness.openWs();
    const instanceId = "presence-watched-sessions";
    try {
      await connectOk(observerWs, { scopes: ["operator.read"] });
      const watchedHello = await connectOk(watchedWs, {
        scopes: ["operator.read"],
        client: {
          id: GATEWAY_CLIENT_IDS.TEST,
          version: "1.0.0",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.TEST,
          instanceId,
        },
      });
      const initialPresenceVersion = (
        watchedHello as { snapshot?: { stateVersion?: { presence?: number } } }
      ).snapshot?.stateVersion?.presence;
      expect(initialPresenceVersion).toEqual(expect.any(Number));

      const findWatchedEntry = (message: unknown) => {
        const record = requireRecord(message, "presence event");
        if (record.event !== "presence") {
          return undefined;
        }
        const payload = requireRecord(record.payload, "presence payload");
        const presence = Array.isArray(payload.presence) ? payload.presence : [];
        return presence.find(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === "object" &&
            (entry as { instanceId?: unknown }).instanceId === instanceId,
        );
      };
      const declaredKeys = ["agent:main:watch-00", "agent:main:watch-01"];
      const declaredPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return (
          Array.isArray(entry?.watchedSessions) &&
          JSON.stringify(entry.watchedSessions) === JSON.stringify(declaredKeys)
        );
      });
      const declaration = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: [declaredKeys[1], declaredKeys[0], declaredKeys[1]],
      });
      expect(declaration).toMatchObject({ ok: true, payload: { sessionKeys: declaredKeys } });
      const declaredEvent = await declaredPresence;
      const declaredEntry = findWatchedEntry(declaredEvent);
      expect(declaredEntry?.watchedSessions).toEqual(declaredKeys);
      expect(declaredEntry?.user).toBeUndefined();
      expect(declaredEvent.stateVersion?.presence).toBeGreaterThan(initialPresenceVersion ?? 0);

      // Sidebar narration owns message subscriptions for running rows, but those
      // transport watches must never impersonate viewer presence.
      const narrationKeys = Array.from(
        { length: 6 },
        (_, index) => `agent:main:narration-${index}`,
      );
      for (const key of narrationKeys) {
        const response = await rpcReq(watchedWs, "sessions.messages.subscribe", { key });
        expect(response.ok).toBe(true);
      }
      const afterNarration = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterNarration.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual(declaredKeys);

      // A failed message release cannot change the independently declared set.
      const failedUnsubscribe = await rpcReq(watchedWs, "sessions.messages.unsubscribe", {
        key: "",
      });
      expect(failedUnsubscribe.ok).toBe(false);
      const afterFailedUnsubscribe = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterFailedUnsubscribe.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual(declaredKeys);

      const replacementKey = "agent:main:replacement";
      const replacementPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return Array.isArray(entry?.watchedSessions) && entry.watchedSessions[0] === replacementKey;
      });
      const replacement = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: [replacementKey],
      });
      expect(replacement).toMatchObject({ ok: true, payload: { sessionKeys: [replacementKey] } });
      const replacementEvent = await replacementPresence;
      expect(findWatchedEntry(replacementEvent)?.watchedSessions).toEqual([replacementKey]);

      const oversized = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: Array.from(
          { length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 1 },
          (_, index) => `agent:main:oversized-${index}`,
        ),
      });
      expect(oversized.ok).toBe(false);
      const afterOversized = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterOversized.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual([replacementKey]);

      const hiddenPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return entry !== undefined && entry.watchedSessions === undefined;
      });
      expect(
        await rpcReq(watchedWs, "sessions.viewers.set", {
          sessionKeys: [],
        }),
      ).toMatchObject({ ok: true, payload: { sessionKeys: [] } });
      const hiddenEvent = await hiddenPresence;
      expect(findWatchedEntry(hiddenEvent)?.watchedSessions).toBeUndefined();

      const redeclaredPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return Array.isArray(entry?.watchedSessions) && entry.watchedSessions[0] === replacementKey;
      });
      await rpcReq(watchedWs, "sessions.viewers.set", { sessionKeys: [replacementKey] });
      await redeclaredPresence;

      const disconnectPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return entry?.reason === "disconnect" && entry.watchedSessions === undefined;
      });
      watchedWs.close();
      const disconnectedEvent = await disconnectPresence;
      const hiddenPresenceVersion = hiddenEvent.stateVersion?.presence;
      expect(disconnectedEvent.stateVersion?.presence).toBeGreaterThan(
        typeof hiddenPresenceVersion === "number" ? hiddenPresenceVersion : 0,
      );
    } finally {
      observerWs.close();
      watchedWs.close();
    }
  });

  test("enforces session-scoped chat delivery on real gateway connections", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        other: { sessionId: "sess-other", updatedAt: Date.now() },
      },
      storePath,
    });
    const copilotOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const copilotClient = {
      id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
      version: "test",
      platform: "chrome",
      deviceFamily: "extension",
      mode: GATEWAY_CLIENT_MODES.UI,
    };
    const copilotIdentityPath = path.join(path.dirname(storePath), "copilot-device.json");
    const unpairedWs = await harness.openWs({ origin: copilotOrigin });
    const pairingWs = await harness.openWs({ origin: copilotOrigin });
    const wrongOriginWs = await harness.openWs({
      origin: "chrome-extension://bcdefghijklmnopabcdefghijklmnopa",
    });
    const mainWs = await harness.openWs({ origin: copilotOrigin });
    const otherWs = await harness.openWs();
    const legacyWs = await harness.openWs();
    try {
      const scopedCaps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      const unpaired = await connectReq(unpairedWs, {
        scopes: ["operator.read", "operator.write"],
        caps: [...scopedCaps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        client: copilotClient,
        deviceIdentityPath: path.join(path.dirname(storePath), "unpaired-copilot-device.json"),
        prePairDevice: false,
      });
      expect(unpaired.ok).toBe(false);
      expect(unpaired.error?.code).toBe("NOT_PAIRED");
      unpairedWs.close();

      const pairedHello = await connectOk(pairingWs, {
        scopes: ["operator.read", "operator.write"],
        caps: [...scopedCaps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        client: copilotClient,
        deviceIdentityPath: copilotIdentityPath,
        prePairDevice: true,
        browserOrigin: copilotOrigin,
      });
      const deviceToken = (pairedHello as { auth?: { deviceToken?: string } }).auth?.deviceToken;
      expect(deviceToken).toBeTruthy();
      pairingWs.close();
      const wrongOrigin = await connectReq(wrongOriginWs, {
        scopes: ["operator.read", "operator.write"],
        caps: [...scopedCaps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        client: copilotClient,
        deviceIdentityPath: copilotIdentityPath,
        deviceToken,
        skipDefaultAuth: true,
      });
      expect(wrongOrigin.ok).toBe(false);
      expect(wrongOrigin.error?.code).toBe("NOT_PAIRED");
      expect(wrongOrigin.error?.message).toContain("dedicated paired device identity");
      wrongOriginWs.close();

      await connectOk(mainWs, {
        scopes: ["operator.read", "operator.write"],
        caps: [...scopedCaps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        client: copilotClient,
        deviceIdentityPath: copilotIdentityPath,
        deviceToken,
        skipDefaultAuth: true,
      });
      await connectOk(otherWs, { scopes: ["operator.read"], caps: scopedCaps });
      await connectOk(legacyWs, { scopes: ["operator.read"] });
      await rpcReq(mainWs, "sessions.messages.subscribe", { key: "main" });
      await rpcReq(otherWs, "sessions.messages.subscribe", { key: "other" });

      const mainEvent = onceMessage(
        mainWs,
        (message) =>
          message.type === "event" &&
          message.event === "chat" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const legacyEvent = onceMessage(
        legacyWs,
        (message) =>
          message.type === "event" &&
          message.event === "chat" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const otherReceived = onceMessage(
        otherWs,
        (message) => message.type === "event" && message.event === "chat",
        300,
      ).then(
        () => true,
        () => false,
      );

      const send = await rpcReq(mainWs, "chat.send", {
        sessionKey: "main",
        message: "/status",
        toolBindings: {
          browser: {
            kind: "tab",
            tabId: 7,
            target: "host",
            profile: "chrome",
            targetId: "target-7",
          },
        },
        idempotencyKey: "scoped-delivery-proof",
      });
      expect(send.ok, JSON.stringify(send)).toBe(true);
      await expect(Promise.all([mainEvent, legacyEvent])).resolves.toHaveLength(2);
      await expect(otherReceived).resolves.toBe(false);
    } finally {
      unpairedWs.close();
      pairingWs.close();
      wrongOriginWs.close();
      mainWs.close();
      otherWs.close();
      legacyWs.close();
    }
  });

  test("rejects client identity changes across a dedicated copilot pairing", async () => {
    const storePath = await createSessionStoreFile();
    const copilotOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const identityPath = path.join(path.dirname(storePath), "other-client-device.json");
    const copilotIdentityPath = path.join(path.dirname(storePath), "copilot-paired-device.json");
    const controlWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const copilotWs = await harness.openWs({
      origin: copilotOrigin,
    });
    const pairingWs = await harness.openWs({
      origin: copilotOrigin,
    });
    const downgradeWs = await harness.openWs();
    const wrongModeWs = await harness.openWs({
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    });
    const webOriginWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const missingCapsWs = await harness.openWs({
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    });
    try {
      const clientBase = {
        version: "test",
        platform: "chrome",
        deviceFamily: "extension",
        mode: GATEWAY_CLIENT_MODES.UI,
      };
      const wrongMode = await connectReq(wrongModeWs, {
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          ...clientBase,
          id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "wrong-mode-device.json"),
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(wrongMode.ok).toBe(false);
      expect(wrongMode.error?.message).toContain("requires ui mode");
      wrongModeWs.close();

      const missingCaps = await connectReq(missingCapsWs, {
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        client: { ...clientBase, id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT },
        deviceIdentityPath: path.join(path.dirname(storePath), "missing-caps-device.json"),
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(missingCaps.ok).toBe(false);
      expect(missingCaps.error?.message).toContain("session-scoped-events");
      missingCapsWs.close();

      const webOrigin = await connectReq(webOriginWs, {
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: { ...clientBase, id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT },
        deviceIdentityPath: path.join(path.dirname(storePath), "web-origin-device.json"),
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(webOrigin.ok).toBe(false);
      expect(webOrigin.error?.message).toContain("canonical Chrome extension origin");
      webOriginWs.close();

      await connectOk(controlWs, {
        client: { ...clientBase, id: GATEWAY_CLIENT_IDS.CONTROL_UI },
        deviceIdentityPath: identityPath,
        prePairDevice: true,
        scopes: ["operator.read", "operator.write"],
      });
      controlWs.close();

      const response = await connectReq(copilotWs, {
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: { ...clientBase, id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT },
        deviceIdentityPath: identityPath,
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("NOT_PAIRED");
      expect(response.error?.message).toContain("dedicated paired device identity");

      await connectOk(pairingWs, {
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: { ...clientBase, id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT },
        deviceIdentityPath: copilotIdentityPath,
        prePairDevice: true,
        browserOrigin: copilotOrigin,
        scopes: ["operator.read", "operator.write"],
      });
      pairingWs.close();

      const downgrade = await connectReq(downgradeWs, {
        client: {
          ...clientBase,
          id: GATEWAY_CLIENT_IDS.TEST,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        deviceIdentityPath: copilotIdentityPath,
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(downgrade.ok).toBe(false);
      expect(downgrade.error?.code).toBe("NOT_PAIRED");
      expect(downgrade.error?.message).toContain("dedicated paired device identity");
    } finally {
      controlWs.close();
      copilotWs.close();
      pairingWs.close();
      downgradeWs.close();
      wrongModeWs.close();
      webOriginWs.close();
      missingCapsWs.close();
    }
  });

  test("broadcasts a recovered subagent terminal session to a subscribed gateway exactly once", async () => {
    const storePath = await createSessionStoreFile();
    const entry: SubagentRunRecord = {
      runId: "run-recovered-subscriber",
      childSessionKey: "agent:main:subagent:recovered-subscriber",
      requesterSessionKey: "agent:main:parent",
      requesterDisplayKey: "parent",
      task: "finish recovered child work",
      cleanup: "keep",
      createdAt: 1_000,
      execution: { status: "running", startedAt: 2_000 },
    };
    await writeSessionStore({
      entries: {
        [entry.childSessionKey]: {
          sessionId: "sess-recovered-subscriber",
          spawnedBy: entry.requesterSessionKey,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = new SubagentLifecycleController({
      runs: new Map([[entry.runId, entry]]),
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      getRuntimeConfig: () => ({}),
      persist: vi.fn(),
      persistOrThrow: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      suppressAnnounceForSteerRestart: () => false,
      resolveSubagentTask: () => ({ lookup: "available" }),
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      emitSubagentProgressEndedForRun,
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      retireSupersededRun: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      callGateway: async <T = Record<string, unknown>>() => ({}) as T,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
      warn: vi.fn(),
    });
    const completion = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error" as const, error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    } satisfies Parameters<typeof controller.completeSubagentRun>[0];

    await withOperatorSessionSubscriber(async (ws) => {
      const waitForRecoveredTerminal = (timeoutMs?: number) =>
        onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "sessions.changed" &&
            (message.payload as { sessionKey?: string; reason?: string } | undefined)
              ?.sessionKey === entry.childSessionKey &&
            (message.payload as { reason?: string } | undefined)?.reason === "subagent-status",
          timeoutMs,
        );
      const changedEvent = waitForRecoveredTerminal();

      await controller.completeSubagentRun(completion);

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        status: "failed",
        endedAt: completion.endedAt,
        spawnedBy: entry.requesterSessionKey,
      });
      expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(entry);

      // A resumed callback must not publish a second terminal event to an
      // already-subscribed Control UI client for the same child generation.
      await expectNoMessageWithin({
        action: () => controller.completeSubagentRun(completion),
        watch: waitForRecoveredTerminal,
      });
      expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(entry);
    });
  });

  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          goal: {
            schemaVersion: 1,
            id: "goal-child",
            objective: "Finish child work",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 42,
            continuationTurns: 0,
          },
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          spawnedCwd: "/tmp/task-repo",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          displayName: "Ops Child",
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEvent = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionLifecycleEvent({
        sessionKey: "agent:main:child",
        reason: "reactivated",
      });

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        displayName: "Ops Child",
        goal: {
          schemaVersion: 1,
          id: "goal-child",
          objective: "Finish child work",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 42,
          continuationTurns: 0,
        },
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = onceMessage(
        subscribedWs,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "subscribed only",
        storePath,
      });
      expect(appended.ok).toBe(true);
      const event = await subscribedEvent;
      expectRecordFields(event, {
        type: "event",
        event: "session.message",
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("keeps web and TUI subscribers on the same authoritative session transcript", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-web-tui-shared";
    const sessionKey = "agent:main:web-tui-shared";
    await writeSessionStore({
      entries: { "web-tui-shared": { sessionId, updatedAt: Date.now() } },
      storePath,
    });

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    let reconnectedTuiWs: Awaited<ReturnType<typeof harness.openWs>> | undefined;
    try {
      await connectOk(webWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
          platform: "web",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "shared-web-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      await connectOk(tuiWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.TUI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "test",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "shared-tui-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", {
          key: sessionKey,
        });
        expect(subscription.ok).toBe(true);
      }

      const sharedMessages = [
        "Sent from the web.",
        "Sent from the TUI.",
        ...Array.from({ length: 30 }, (_, index) => `Shared burst message ${index + 1}.`),
      ];
      for (const [index, text] of sharedMessages.entries()) {
        const messageId = `shared-turn-${index + 1}`;
        const deliveries = [webWs, tuiWs].map((ws) =>
          onceMessage(
            ws,
            (frame) =>
              frame.type === "event" &&
              frame.event === "session.message" &&
              (frame.payload as { messageId?: string } | undefined)?.messageId === messageId,
          ),
        );
        const persisted = await persistSessionTranscriptTurn(
          { agentId: "main", sessionId, sessionKey, storePath },
          {
            messages: [
              {
                eventId: messageId,
                message: {
                  content: [{ type: "text", text }],
                  idempotencyKey: `${messageId}:user`,
                  role: "user",
                  timestamp: Date.now(),
                },
              },
            ],
          },
        );
        expect(persisted.appendedCount).toBe(1);
        for (const delivery of await Promise.all(deliveries)) {
          expectRecordFields(delivery.payload, {
            messageId,
            messageSeq: index + 1,
            sessionKey,
          });
          expect(requireRecord(delivery.payload, "shared session event").message).toMatchObject({
            __openclaw: {
              id: messageId,
              idempotencyKey: `${messageId}:user`,
              seq: index + 1,
            },
            content: [{ type: "text", text }],
            role: "user",
          });
        }
      }

      tuiWs.close();
      reconnectedTuiWs = await harness.openWs();
      await connectOk(reconnectedTuiWs, { scopes: ["operator.read"] });
      const history = await rpcReq(reconnectedTuiWs, "chat.history", { sessionKey });
      expect(history.ok).toBe(true);
      expect((history.payload as { messages?: unknown[] }).messages).toMatchObject(
        sharedMessages.map((text) => ({
          content: [{ type: "text", text }],
          role: "user",
        })),
      );
    } finally {
      webWs.close();
      tuiWs.close();
      reconnectedTuiWs?.close();
    }
  });

  test("projects current revisioned sender avatars consistently across live events and RPC reads", async () => {
    const SHARED_REV = 1_800_000_000_000;
    const profileState = await createOpenClawTestState({
      label: "session-message-current-profile-display",
      layout: "state-only",
    });
    cleanupTestStates.push(profileState);
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-current-profile-display";
    const sessionKey = "agent:main:current-profile-display";
    const sessionEntry = { sessionId, updatedAt: 1 };
    await writeSessionStore({
      entries: { "current-profile-display": sessionEntry },
      storePath,
    });

    const profile = withMockedDateNow(SHARED_REV, () => {
      // Avoid random UUID spans such as `fc-...` that transcript redaction treats as secrets.
      const created = (() => {
        const profileIdSpy = vi
          .spyOn(secureRandom, "generateSecureUuid")
          .mockReturnValue("00000000-0000-4000-8000-000000000001");
        try {
          return ensureProfileForEmail("current-profile-display@example.com");
        } finally {
          profileIdSpy.mockRestore();
        }
      })();
      setDisplayName(created.id, "Old Display Name");
      expect(setAvatar(created.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      return created;
    });
    const firstAvatarUrl = currentProfileAvatarUrl(profile.id);

    const ws = await harness.openWs();
    try {
      await connectOk(ws, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        scopes: ["operator.read"],
      });
      const subscription = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(subscription.ok).toBe(true);

      const persistTurn = async (params: {
        idempotencyKey: string;
        senderName: string;
        text: string;
      }) => {
        const liveEvent = waitForSessionMessageEvent(ws, sessionKey);
        const persisted = await persistUserTurnTranscript({
          agentId: "main",
          sessionEntry,
          sessionId,
          sessionKey,
          storePath,
          input: {
            idempotencyKey: params.idempotencyKey,
            sender: {
              id: profile.id,
              name: params.senderName,
              username: "ada",
            },
            text: params.text,
          },
        });
        expect(persisted).toBeDefined();
        return { persisted: persisted!, liveEvent: await liveEvent };
      };
      const readHistoryMessage = async (messageId: string) => {
        const response = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
          sessionKey,
        });
        expect(response.ok).toBe(true);
        const messages = response.payload?.messages ?? [];
        const message = messages.find((candidate) => {
          const record = requireRecord(candidate, "history message");
          const metadata = requireRecord(record["__openclaw"], "history message metadata");
          return metadata.id === messageId;
        });
        expect(message).toBeDefined();
        return message;
      };
      const readMessage = async (messageId: string) => {
        const response = await rpcReq<{ ok?: boolean; message?: unknown }>(ws, "chat.message.get", {
          sessionKey,
          messageId,
        });
        expect(response.ok).toBe(true);
        expect(response.payload?.ok).toBe(true);
        return response.payload?.message;
      };
      const expectedProjection = (text: string, senderName: string, avatarUrl: string) => ({
        role: "user",
        content: text,
        __openclaw: {
          senderId: profile.id,
          senderName,
          senderUsername: "ada",
          senderProfileAvatarUrl: avatarUrl,
        },
      });
      const expectRpcParity = async (messageId: string, expected: unknown) => {
        expect(attributedMessageProjection(await readHistoryMessage(messageId))).toEqual(expected);
        expect(attributedMessageProjection(await readMessage(messageId))).toEqual(expected);
      };
      const expectEmitterParity = async (
        turn: Awaited<ReturnType<typeof persistTurn>>,
        expected: unknown,
      ) => {
        const liveMessage = requireRecord(
          turn.liveEvent.payload,
          "session.message payload",
        ).message;
        expect(attributedMessageProjection(liveMessage)).toEqual(expected);
        await expectRpcParity(turn.persisted.messageId, expected);
      };

      const first = await persistTurn({
        idempotencyKey: "current-profile-display:first",
        senderName: "Historical Ada",
        text: "first attributed turn",
      });
      const firstExpected = expectedProjection(
        "first attributed turn",
        "Historical Ada",
        firstAvatarUrl,
      );
      await expectEmitterParity(first, firstExpected);

      withMockedDateNow(SHARED_REV, () => {
        setDisplayName(profile.id, "Current Ada");
        expect(setAvatar(profile.id, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
      });
      const secondAvatarUrl = currentProfileAvatarUrl(profile.id);
      expect(secondAvatarUrl).not.toBe(firstAvatarUrl);

      const second = await persistTurn({
        idempotencyKey: "current-profile-display:second",
        senderName: "Current Ada",
        text: "second attributed turn",
      });
      const secondExpected = expectedProjection(
        "second attributed turn",
        "Current Ada",
        secondAvatarUrl,
      );
      await expectEmitterParity(second, secondExpected);

      const refreshedFirstExpected = expectedProjection(
        "first attributed turn",
        "Historical Ada",
        secondAvatarUrl,
      );
      await expectRpcParity(first.persisted.messageId, refreshedFirstExpected);
    } finally {
      ws.close();
    }
  });

  test("delivers every message from one committed turn to web and TUI in transcript order", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-web-tui-committed-turn";
    const sessionKey = "agent:main:web-tui-committed-turn";
    await writeSessionStore({
      entries: { "web-tui-committed-turn": { sessionId, updatedAt: Date.now() } },
      storePath,
    });

    const earlierMessage = {
      id: "committed-existing-turn",
      text: "An existing message establishes the active-branch sequence.",
    };
    const seeded = await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [
          {
            eventId: earlierMessage.id,
            message: {
              content: [{ type: "text", text: earlierMessage.text }],
              idempotencyKey: `${earlierMessage.id}:user`,
              role: "user",
              timestamp: 1_699_999_999_999,
            },
          },
        ],
      },
    );
    expect(seeded.appendedCount).toBe(1);

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    const committedMessages = [
      { id: "committed-web-turn", text: "The same prompt from either client." },
      { id: "committed-tui-turn", text: "The same prompt from either client." },
      { id: "committed-final-turn", text: "The third message in the same transaction." },
    ];

    try {
      await connectOk(webWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
          platform: "web",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "committed-web-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      await connectOk(tuiWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.TUI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "test",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "committed-tui-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", {
          key: sessionKey,
        });
        expect(subscription.ok).toBe(true);
      }

      const observedByClient: Array<
        Array<{ messageId: unknown; messageSeq: unknown; sessionKey: unknown }>
      > = [[], []];
      for (const [clientIndex, ws] of [webWs, tuiWs].entries()) {
        const observed = observedByClient[clientIndex];
        if (!observed) {
          throw new Error(`missing committed-turn observer for client ${clientIndex}`);
        }
        ws.on("message", (data: RawData) => {
          const frame = JSON.parse(rawDataToString(data)) as {
            event?: string;
            payload?: { messageId?: unknown; messageSeq?: unknown; sessionKey?: unknown };
            type?: string;
          };
          if (
            frame.type === "event" &&
            frame.event === "session.message" &&
            frame.payload?.sessionKey === sessionKey
          ) {
            observed.push({
              messageId: frame.payload.messageId,
              messageSeq: frame.payload.messageSeq,
              sessionKey: frame.payload.sessionKey,
            });
          }
        });
      }

      // Install every real socket listener before the one SQLite commit can broadcast.
      const deliveriesByClient = [webWs, tuiWs].map((ws) =>
        committedMessages.map(({ id }) =>
          onceMessage(
            ws,
            (frame) =>
              frame.type === "event" &&
              frame.event === "session.message" &&
              (frame.payload as { messageId?: string } | undefined)?.messageId === id,
          ),
        ),
      );
      const committedTurn = {
        messages: committedMessages.map(({ id, text }, index) => ({
          eventId: id,
          message: {
            content: [{ type: "text", text }],
            idempotencyKey: `${id}:user`,
            role: "user",
            timestamp: 1_700_000_000_000 + index,
          },
        })),
      };
      const persisted = await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        committedTurn,
      );
      expect(persisted.appendedCount).toBe(committedMessages.length);

      for (const [clientIndex, clientDeliveries] of deliveriesByClient.entries()) {
        const frames = await Promise.all(clientDeliveries);
        expect(observedByClient[clientIndex]).toEqual(
          committedMessages.map(({ id }, index) => ({
            messageId: id,
            messageSeq: index + 2,
            sessionKey,
          })),
        );
        expect(
          frames.map((frame) => {
            const payload = requireRecord(frame.payload, "committed session event");
            return {
              messageId: payload.messageId,
              messageSeq: payload.messageSeq,
              sessionKey: payload.sessionKey,
            };
          }),
        ).toEqual(
          committedMessages.map(({ id }, index) => ({
            messageId: id,
            messageSeq: index + 2,
            sessionKey,
          })),
        );
        for (const [index, frame] of frames.entries()) {
          const expected = committedMessages[index];
          if (!expected) {
            throw new Error(`unexpected committed-turn delivery at index ${index}`);
          }
          expect(requireRecord(frame.payload, "committed session event").message).toMatchObject({
            __openclaw: {
              id: expected.id,
              idempotencyKey: `${expected.id}:user`,
              seq: index + 2,
            },
            content: [{ type: "text", text: expected.text }],
            role: "user",
          });
        }
      }

      const history = await rpcReq(tuiWs, "chat.history", { sessionKey });
      expect(history.ok).toBe(true);
      expect((history.payload as { messages?: unknown[] }).messages).toMatchObject(
        [earlierMessage, ...committedMessages].map(({ id, text }, index) => ({
          __openclaw: { id, idempotencyKey: `${id}:user`, seq: index + 1 },
          content: [{ type: "text", text }],
          role: "user",
        })),
      );

      const duplicateDeliveries = [webWs, tuiWs].map((ws) =>
        onceMessage(
          ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "session.message" &&
            (frame.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
          300,
        ).then(
          () => true,
          () => false,
        ),
      );
      const replayed = await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        committedTurn,
      );
      expect(replayed.appendedCount).toBe(0);
      await expect(Promise.all(duplicateDeliveries)).resolves.toEqual([false, false]);
    } finally {
      webWs.close();
      tuiWs.close();
    }
  });

  test("invalidates the selected web and TUI transcript once for an identity-only committed turn", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-web-tui-identity-only";
    const sessionKey = "agent:main:web-tui-identity-only";
    const lifecycleRevision = "identity-only-committed-revision";
    await writeSessionStore({
      entries: {
        "web-tui-identity-only": { sessionId, lifecycleRevision, updatedAt: Date.now() },
        "web-tui-wrong-session": {
          sessionId: "sess-web-tui-wrong-session",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    const wrongSessionWs = await harness.openWs();
    try {
      await connectOk(webWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
          platform: "web",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "identity-only-web-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      await connectOk(tuiWs, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        client: {
          id: GATEWAY_CLIENT_IDS.TUI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "test",
          version: "test",
        },
        deviceIdentityPath: path.join(path.dirname(storePath), "identity-only-tui-device.json"),
        prePairDevice: true,
        scopes: ["operator.read"],
      });
      await connectOk(wrongSessionWs, { scopes: ["operator.read"] });
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
        expect(subscription.ok).toBe(true);
      }
      const wrongSubscription = await rpcReq(wrongSessionWs, "sessions.messages.subscribe", {
        key: "agent:main:web-tui-wrong-session",
      });
      expect(wrongSubscription.ok).toBe(true);

      await withOperatorSessionSubscriber(async (broadWs) => {
        const observers = [webWs, tuiWs, broadWs];
        const observedInvalidations: Array<Array<Record<string, unknown>>> = observers.map(
          () => [],
        );
        for (const [index, ws] of observers.entries()) {
          const observed = observedInvalidations[index];
          if (!observed) {
            throw new Error(`missing identity-only transcript observer ${index}`);
          }
          ws.on("message", (data: RawData) => {
            const frame = JSON.parse(rawDataToString(data)) as {
              event?: string;
              payload?: Record<string, unknown>;
              type?: string;
            };
            if (
              frame.type === "event" &&
              frame.event === "sessions.changed" &&
              frame.payload?.phase === "message" &&
              frame.payload.sessionKey === sessionKey
            ) {
              observed.push(frame.payload);
            }
          });
        }

        const invalidations = observers.map((ws) =>
          waitForSessionsChangedMessagePhase(ws, sessionKey),
        );
        const unexpectedFrames = [webWs, tuiWs, wrongSessionWs].map((ws) =>
          onceMessage(
            ws,
            (frame) =>
              frame.type === "event" &&
              (frame.event === "session.message" ||
                (ws === wrongSessionWs && frame.event === "sessions.changed")) &&
              (frame.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
            300,
          ).then(
            () => true,
            () => false,
          ),
        );

        const committed = await persistSessionTranscriptTurn(
          { agentId: "main", sessionId, sessionKey, storePath },
          {
            messages: ["first", "second"].map((name, index) => ({
              eventId: `identity-only-${name}`,
              message: {
                content: [{ type: "text", text: `Identity-only committed message ${index + 1}.` }],
                idempotencyKey: `identity-only-${name}:user`,
                role: "user",
                timestamp: 1_700_000_000_000 + index,
              },
            })),
            updateMode: "file-only",
          },
        );
        expect(committed.appendedCount).toBe(2);

        for (const frame of await Promise.all(invalidations)) {
          const payload = requireRecord(frame.payload, "identity-only transcript invalidation");
          expect(payload).toMatchObject({ phase: "message", sessionKey });
          for (const privateField of [
            "lifecycleRevision",
            "message",
            "messageId",
            "messageSeq",
            "storePath",
          ]) {
            expect(payload).not.toHaveProperty(privateField);
          }
          expect(JSON.stringify(payload)).not.toContain(storePath);
          expect(JSON.stringify(payload)).not.toContain(lifecycleRevision);
        }
        await expect(Promise.all(unexpectedFrames)).resolves.toEqual([false, false, false]);
        expect(observedInvalidations.map((frames) => frames.length)).toEqual([1, 1, 1]);
      });
    } finally {
      webWs.close();
      tuiWs.close();
      wrongSessionWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "live websocket message",
        storePath,
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      const emitParams = requireRecord(emitSpy.mock.calls.at(0)?.[0], "transcript update params");
      expect(emitParams.sessionKey).toBe("agent:main:main");
      expect(emitParams.target).toMatchObject({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
      });
      expect(emitParams.messageId).toBe(appended.messageId);
      expectRecordFields(emitParams.message, {
        role: "assistant",
        content: [{ type: "text", text: "live websocket message" }],
      });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "live websocket message" }],
          }),
          type: "message",
        }),
      );
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("strips blocked original content from live session.message events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      JSON.stringify({ type: "session", version: 1, id: "sess-main" }) + "\n",
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        messageId: "blocked-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: { blockedBy: "policy-plugin", blockedAt: 1 },
          },
        },
      });

      const payload = messageEvent.payload as {
        message?: { content?: unknown; __openclaw?: { beforeAgentRunBlocked?: unknown } };
      };
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("broadcasts redacted blocked user appends to live session listeners", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
        sessionKey: "agent:main:main",
        messageId: "blocked-message",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: {
              blockedBy: "policy-plugin",
              blockedAt: Date.now(),
            },
          },
        },
      });

      const messageEvent = await messageEventPromise;
      const payload = messageEvent.payload as {
        message?: {
          role?: unknown;
          content?: unknown;
          __openclaw?: { beforeAgentRunBlocked?: unknown };
        };
      };
      expect(payload.message?.role).toBe("user");
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("does not broadcast hidden runtime-context custom messages as live chat messages", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        "hidden-runtime": {
          sessionId: "sess-hidden-runtime",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEventPromise = waitForSessionsChangedMessagePhase(
        ws,
        "agent:main:hidden-runtime",
      );
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:hidden-runtime",
            timeoutMs,
          ),
        action: () => {
          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-hidden-runtime.jsonl"),
            sessionKey: "agent:main:hidden-runtime",
            messageId: "runtime-context-1",
            messageSeq: 1,
            message: {
              role: "custom",
              customType: "openclaw.runtime-context",
              content: "secret runtime context",
              display: false,
            },
          });
        },
      });

      const changedEvent = await changedEventPromise;
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:hidden-runtime",
        phase: "message",
        goal: null,
      });
    });
  });

  test("does not duplicate displayable transcript updates with sessions.changed", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await expectNoMessageWithin({
        action: () => {
          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
            sessionKey: "agent:main:main",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "single frame" }],
              timestamp: Date.now(),
            },
            messageId: "msg-single-frame",
            messageSeq: 1,
          });
        },
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "sessions.changed" &&
              (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
                "message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
      });
      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-single-frame",
        messageSeq: 1,
      });
    });
  });

  test("broadcasts identity-only transcript updates to live session listeners", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
        },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "identity frame" }],
          timestamp: Date.now(),
        },
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });
    });
  });

  test("includes live usage metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
          modelProvider: "openai",
          model: "gpt-5.4",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "usage snapshot" }],
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 2_000,
        output: 400,
        cacheRead: 300,
        cacheWrite: 100,
        cost: { total: 0.0042 },
      },
      timestamp: Date.now(),
    };
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        messages: [{ message: transcriptMessage }],
        updateMode: "none",
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: "agent:main:main",
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
    });
  });

  test("prefers carried transcript sequence for live session events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: path.join(path.dirname(storePath), "missing-transcript.jsonl"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "carried sequence" }],
          timestamp: Date.now(),
        },
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      const payload = requireRecord(messageEvent.payload, "session.message payload");
      const message = requireRecord(payload.message, "session.message payload message");
      expect((message["__openclaw"] as { seq?: unknown } | undefined)?.seq).toBe(7);
    });
  });

  test("derives message sequence for selected-session transcript subscribers", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "early selected prompt" }],
      timestamp: Date.now(),
    };
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        messages: [{ message: transcriptMessage }],
        updateMode: "none",
      },
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath,
        },
        message: transcriptMessage,
        messageId: "msg-selected",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-selected",
        messageSeq: 1,
      });
    } finally {
      ws.close();
    }
  });

  test("routes selected-agent global transcript updates to matching message subscribers", async () => {
    const storePath = await createSessionStoreFile();
    testState.agentsConfig = {
      ownership: "explicit",
      list: [{ id: "main" }, { id: "work" }],
    };
    testState.agentConfig = { sessionStore: { agentId: "work" } };
    const transcriptPath = path.join(path.dirname(storePath), "global-work.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-work-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          goal: {
            schemaVersion: 1,
            id: "goal-work-global",
            objective: "Finish work global task",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 5,
            continuationTurns: 0,
          },
        },
      },
      storePath,
      agentId: "work",
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "work selected global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-work-global" }),
        JSON.stringify({ id: "msg-work-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      expect(
        await rpcReq(workWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "work",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });
      expect(
        await rpcReq(mainWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "main",
        }),
      ).toMatchObject({ ok: false });
      expect(
        await rpcReq(bareWs, "sessions.messages.subscribe", {
          key: "global",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });

      const workMessagePromise = waitForSessionMessageEvent(workWs, "global");
      const mainMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(mainWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        agentId: "work",
        message: transcriptMessage,
        messageId: "msg-work-global",
      });

      const workMessage = await workMessagePromise;
      await mainMessagePromise;
      const bareMessage = await bareMessagePromise;
      expectRecordFields(workMessage.payload, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-work-global",
        goal: {
          schemaVersion: 1,
          id: "goal-work-global",
          objective: "Finish work global task",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 5,
          continuationTurns: 0,
        },
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-work-global",
      });
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
      testState.agentsConfig = undefined;
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("routes a subscribed global observer event through the real gateway socket once", async () => {
    const storePath = await createSessionStoreFile();
    testState.agentsConfig = {
      ownership: "explicit",
      list: [{ id: "main" }, { id: "work" }],
    };
    testState.agentConfig = { sessionStore: { agentId: "work" } };
    await writeSessionStore({
      entries: { global: { sessionId: "sess-work-observer", updatedAt: Date.now() } },
      storePath,
      agentId: "work",
    });
    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const runId = "run-work-global-observer";
    const workEvents: unknown[] = [];
    const mainEvents: unknown[] = [];
    const collect = (target: unknown[]) => (data: RawData) => {
      const message = JSON.parse(rawDataToString(data)) as { event?: string; payload?: unknown };
      if (message.event === "session.observer") {
        target.push(message.payload);
      }
    };
    const collectWork = collect(workEvents);
    const collectMain = collect(mainEvents);
    workWs.on("message", collectWork);
    mainWs.on("message", collectMain);
    try {
      const caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      await connectOk(workWs, { scopes: ["operator.read"], caps });
      await connectOk(mainWs, { scopes: ["operator.read"], caps });
      expect(
        await rpcReq(workWs, "sessions.messages.subscribe", {
          key: " GLOBAL ",
          agentId: " WORK ",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });
      expect(
        await rpcReq(mainWs, "sessions.messages.subscribe", { key: "global", agentId: "main" }),
      ).toMatchObject({ ok: false });
      await rpcReq(workWs, "sessions.observer.visibility", { visible: true });
      await rpcReq(mainWs, "sessions.observer.visibility", { visible: true });

      const workEvent = waitForSessionObserverEvent(workWs, runId);
      const noMainEvent = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionObserverEvent(mainWs, runId, timeoutMs),
        timeoutMs: 250,
      });
      emitAgentEvent({
        runId,
        sessionKey: "global",
        agentId: "work",
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          progressText: "Inspecting the work session",
        },
      });

      await workEvent;
      await noMainEvent;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(workEvents).toHaveLength(1);
      expect(mainEvents).toHaveLength(0);
    } finally {
      workWs.off("message", collectWork);
      mainWs.off("message", collectMain);
      workWs.close();
      mainWs.close();
      testState.agentsConfig = undefined;
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("routes unscoped global transcript events to default-agent global subscribers", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-default-global.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-default-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "default global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-default-global" }),
        JSON.stringify({ id: "msg-default-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      await rpcReq(workWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "work",
      });
      await rpcReq(mainWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "main",
      });
      await rpcReq(bareWs, "sessions.messages.subscribe", {
        key: "global",
      });

      const mainMessagePromise = waitForSessionMessageEvent(mainWs, "global");
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      const workMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(workWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        message: transcriptMessage,
        messageId: "msg-default-global",
      });

      const mainMessage = await mainMessagePromise;
      const bareMessage = await bareMessagePromise;
      await workMessagePromise;
      expectRecordFields(mainMessage.payload, {
        sessionKey: "global",
        messageId: "msg-default-global",
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        messageId: "msg-default-global",
      });
      expect((mainMessage.payload as { agentId?: unknown }).agentId).toBeUndefined();
      expect((bareMessage.payload as { agentId?: unknown }).agentId).toBeUndefined();
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
    }
  });

  test("routes default-agent scoped global transcript events to legacy global subscribers", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-default-scoped-global.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-default-scoped-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
      storePath,
      agentId: "main",
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "default scoped global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-default-scoped-global" }),
        JSON.stringify({ id: "msg-default-scoped-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      await rpcReq(workWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "work",
      });
      await rpcReq(mainWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "main",
      });
      await rpcReq(bareWs, "sessions.messages.subscribe", {
        key: "global",
      });

      const mainMessagePromise = waitForSessionMessageEvent(mainWs, "global");
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      const workMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(workWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        agentId: "main",
        message: transcriptMessage,
        messageId: "msg-default-scoped-global",
      });

      const mainMessage = await mainMessagePromise;
      const bareMessage = await bareMessagePromise;
      await workMessagePromise;
      expectRecordFields(mainMessage.payload, {
        sessionKey: "global",
        agentId: "main",
        messageId: "msg-default-scoped-global",
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        agentId: "main",
        messageId: "msg-default-scoped-global",
      });
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
    }
  });

  test("includes spawnedBy metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-child.jsonl");
    await writeSessionStore({
      entries: {
        child: {
          sessionId: "sess-child",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          parentSessionKey: "agent:main:main",
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "spawn metadata snapshot" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({ id: "msg-spawn", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-thread.jsonl");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-thread",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "thread route snapshot" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-thread" }),
        JSON.stringify({ id: "msg-thread", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        worker: {
          sessionId: "sess-worker",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          text: "main only",
          storePath,
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            timeoutMs,
          ),
        action: async () => {
          const workerAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:worker",
            text: "worker hidden",
            storePath,
          });
          expect(workerAppend.ok).toBe(true);
        },
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            text: "hidden after unsubscribe",
            storePath,
          });
          expect(hiddenAppend.ok).toBe(true);
        },
      });
    } finally {
      ws.close();
    }
  });

  test("streams worker commits and local-equivalent live events to the selected session", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-worker-commit-fanout";
    const sessionKey = "agent:main:worker";
    await writeSessionStore({
      entries: {
        worker: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      session: { mainKey: "main", store: storePath },
    };
    const ledger: WorkerTranscriptCommitStore = {
      begin: () => ({ kind: "claimed" }),
      complete: ({ outcome }) => outcome,
    };
    const committer = createWorkerTranscriptCommitter({ getConfig: () => config, store: ledger });
    const identity: WorkerConnectionIdentity = {
      environmentId: "environment-fanout",
      credentialHash: ["fanout", "credential", "hash"].join("-"),
      bundleHash: "f".repeat(64),
      sessionId,
      runId: "run-fanout",
      ownerEpoch: 4,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-live-event-v1", "worker-transcript-commit-v1"],
      credentialExpiresAtMs: Date.now() + 10_000,
    };
    const receiver = createWorkerLiveEventReceiver({
      getConfig: () => config,
      startupBindings: [{ environmentId: identity.environmentId, runEpoch: 4, sessionId }],
      startupOwners: new Map([[identity.environmentId, 4]]),
    });
    const ws = await harness.openWs();
    const workerChats: Record<string, unknown>[] = [];
    const collectWorkerChats = (data: RawData) => {
      const message = JSON.parse(rawDataToString(data)) as {
        type?: string;
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (
        message.type === "event" &&
        message.event === "chat" &&
        message.payload?.runId === "worker"
      ) {
        workerChats.push(message.payload);
      }
    };
    ws.on("message", collectWorkerChats);
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe(sessionKey);

      const eventPromises = [1, 2, 3].map((messageSeq) =>
        onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "session.message" &&
            (message.payload as { sessionKey?: unknown } | undefined)?.sessionKey === sessionKey &&
            (message.payload as { messageSeq?: unknown } | undefined)?.messageSeq === messageSeq,
        ),
      );
      const outcome = await committer.commit({
        identity,
        request: {
          runEpoch: identity.ownerEpoch,
          seq: 1,
          baseLeafId: null,
          messages: ["first", "second", "third"].map((text, index) => ({
            role: "user" as const,
            content: [{ type: "text" as const, text }],
            timestamp: 100 + index,
          })),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(`expected worker transcript commit, received ${outcome.reason}`);
      }
      const events = await Promise.all(eventPromises);
      const payloads = events.map((event) =>
        requireRecord(event.payload, "session.message payload"),
      );
      expect(payloads.map((payload) => payload.messageId)).toEqual(outcome.result.entryIds);
      expect(payloads.map((payload) => payload.messageSeq)).toEqual([1, 2, 3]);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").id;
        }),
      ).toEqual(outcome.result.entryIds);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").seq;
        }),
      ).toEqual([1, 2, 3]);

      const waitForChat = (runId: string, timeoutMs?: number) =>
        onceMessage(
          ws,
          ({ type, event, payload }) =>
            type === "event" &&
            event === "chat" &&
            (payload as Record<string, unknown>).runId === runId,
          timeoutMs,
        );
      const liveEvent = {
        event: { kind: "assistant", payload: { text: "hello", delta: "hello" } },
        lastAckedSeq: 0,
        seq: 1,
      } as const;
      const push = (runEpoch = 4, runId = "worker") =>
        receiver.apply({ identity, request: { ...liveEvent, runEpoch, runId } });
      const [workerEvent] = await Promise.all([
        waitForChat("worker"),
        expectNoMessageWithin({
          watch: (timeoutMs) => waitForSessionMessageEvent(ws, sessionKey, timeoutMs),
          action: () => expect(push().ok).toBe(true),
        }),
      ]);
      const workerChat = requireRecord(workerEvent.payload, "worker chat");
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("worker", timeoutMs),
        action: () => {
          expect(push()).toEqual({ ok: true, result: { ackedSeq: 1 } });
        },
      });
      expect(workerChats).toHaveLength(1);

      claimAgentRunContext("local", {
        sessionKey,
        sessionId,
        agentId: "main",
        isControlUiVisible: false,
      });
      const localEvent = waitForChat("local");
      emitAgentEvent({
        runId: "local",
        stream: "assistant",
        data: { text: "hello", delta: "hello" },
      });
      const localChat = requireRecord((await localEvent).payload, "local chat");
      for (const payload of [workerChat, localChat]) {
        payload.runId = "normalized";
        requireRecord(payload.message, "chat message").timestamp = 0;
      }
      expect(workerChat).toEqual(localChat);
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("stale", timeoutMs),
        action: () => expect(push(3, "stale").ok).toBe(false),
      });
    } finally {
      receiver.clear();
      clearAgentRunContext("local");
      ws.off("message", collectWorkerChats);
      ws.close();
    }
  });

  test("routes transcript-only SQLite marker updates to the matching session owner", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        older: {
          sessionId: "sess-old",
          updatedAt: Date.now(),
        },
        newer: {
          sessionId: "sess-new",
          updatedAt: Date.now() + 10,
        },
      },
      storePath,
    });
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "shared transcript update" }],
      timestamp: Date.now(),
    };
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-new",
        sessionKey: "agent:main:newer",
        storePath,
      },
      {
        messages: [{ message }],
        updateMode: "none",
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:newer");

      emitSessionTranscriptUpdate({
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "sess-new",
          storePath,
        }),
        message,
        messageId: "msg-shared",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:newer",
        messageId: "msg-shared",
        messageSeq: 1,
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
