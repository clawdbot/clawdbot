import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
} from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import {
  CommandLaneClearedError,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  upstreamFork: vi.fn(),
  readMediaBuffer: vi.fn(),
}));

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return { ...actual, readMediaBuffer: mocks.readMediaBuffer };
});

import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type { GatewayClient } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:rewind-handler";
const sourceSessionId = "rewind-handler-source";
const sessionLane = resolveEmbeddedSessionLane(sessionKey);
const storedImageId = "stored-image.png";
const storedImagePath = `/state/media/inbound/${storedImageId}`;
const storedImageData = Buffer.from("stored-image");
const queuedCommandSettlements = new Set<Promise<void>>();

beforeEach(async () => {
  mocks.upstreamFork.mockReset();
  mocks.readMediaBuffer.mockReset().mockImplementation(async (id: string) => {
    if (id !== storedImageId) {
      throw new Error(`missing media: ${id}`);
    }
    return {
      id,
      path: storedImagePath,
      buffer: storedImageData,
      size: storedImageData.byteLength,
    };
  });
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-rewind-handler-"));
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId: sourceSessionId,
      updatedAt: Date.now(),
    },
  );
  for (const event of [
    { type: "session", id: sourceSessionId, version: 3 },
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "edit me" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        __openclaw: {
          media: [
            { path: storedImagePath, contentType: "image/png" },
            // Duplicate ref proves dedupe: the response must carry this image once.
            { path: storedImagePath, contentType: "image/png" },
            { path: `${storedImagePath}.missing`, contentType: "image/png" },
          ],
        },
      },
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "user-entry",
      message: { role: "assistant", content: "answer" },
    },
    {
      type: "message",
      id: "off-path-entry",
      parentId: null,
      message: { role: "user", content: "inactive" },
    },
    {
      type: "leaf",
      id: "active-leaf",
      parentId: "off-path-entry",
      targetId: "assistant-entry",
    },
  ]) {
    const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
    if (event.type === "message") {
      await appendTranscriptMessage(scope, {
        eventId: event.id,
        message: event.message,
        parentId: event.parentId,
      });
    } else {
      await appendTranscriptEvent(scope, event);
    }
  }
});

afterEach(async () => {
  clearSessionQueues([sessionKey, sourceSessionId]);
  setCommandLaneConcurrency(sessionLane, 1);
  await Promise.all(queuedCommandSettlements);
  queuedCommandSettlements.clear();
  resetPluginRuntimeStateForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function context(active = false): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(
      active ? [["active-run", { sessionId: sourceSessionId, sessionKey }]] : undefined,
    ),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

type MessageCutMethod =
  | "sessions.branches.list"
  | "sessions.branches.switch"
  | "sessions.fork"
  | "sessions.rewind";

async function invoke(
  method: MessageCutMethod,
  entryId?: string,
  client: GatewayClient | null = null,
  active = false,
) {
  const respond = vi.fn();
  await expectDefined(
    sessionRewindHandlers[method],
    `${method} handler`,
  )({
    req: { id: `${method}-request` } as never,
    params: {
      sessionKey,
      ...(method === "sessions.branches.switch"
        ? { leafEntryId: entryId }
        : method === "sessions.branches.list"
          ? {}
          : { entryId }),
    },
    respond: respond as unknown as RespondFn,
    context: context(active),
    client,
    isWebchatConnect: () => false,
  });
  return respond;
}

type QueuedSessionWork = {
  command: Promise<string>;
  followup: FollowupRun;
  hasCommandRun: () => boolean;
};

function enqueueSessionWork(label: string): QueuedSessionWork {
  const followupFixture = createQueueTestRun({ prompt: `${label} follow-up` });
  const followup: FollowupRun = {
    ...followupFixture,
    run: {
      ...followupFixture.run,
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey,
    },
  };
  expect(
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false),
  ).toBe(true);

  setCommandLaneConcurrency(sessionLane, 0);
  let commandRan = false;
  const command = enqueueCommandInLane(sessionLane, async () => {
    commandRan = true;
    return `${label} command`;
  });
  const settlement = command.then(
    () => undefined,
    () => undefined,
  );
  queuedCommandSettlements.add(settlement);

  return { command, followup, hasCommandRun: () => commandRan };
}

function expectSessionWorkQueued(work: QueuedSessionWork): void {
  expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  expect(work.followup.queueAbortSignal?.aborted).toBe(false);
  expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
    activeCount: 0,
    queuedCount: 1,
  });
  expect(work.hasCommandRun()).toBe(false);
}

async function expectSessionWorkCleared(work: QueuedSessionWork): Promise<void> {
  expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  expect(work.followup.queueAbortSignal?.aborted).toBe(true);
  expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
    activeCount: 0,
    queuedCount: 0,
  });
  await expect(work.command).rejects.toBeInstanceOf(CommandLaneClearedError);
  expect(work.hasCommandRun()).toBe(false);
}

function linkToUpstreamConversation(): void {
  expect(
    upsertSessionUpstreamLink({
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      marker: { turnId: "turn-2", userMessageCount: 1 },
      sessionKey,
      threadId: "thread-source",
      upstreamKind: "codex-app-server",
      upstreamRef: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
    }),
  ).toBe(true);
}

function installUpstreamForkHarness(): void {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "test-harness",
    source: "runtime",
    harness: {
      id: "test-harness",
      label: "Test harness",
      runAttempt: async () => {
        throw new Error("not used");
      },
      sessionFork: {
        upstreamKinds: ["codex-app-server"],
        fork: mocks.upstreamFork,
      },
      supports: () => ({ supported: false }),
    },
  });
  setActivePluginRegistry(registry);
}

describe("session message-cut methods", () => {
  it("returns an empty branch list for a not-yet-materialized session", async () => {
    const respond = vi.fn() as unknown as RespondFn;
    await expectDefined(
      sessionRewindHandlers["sessions.branches.list"],
      "sessions.branches.list handler",
    )({
      req: { id: "fresh-branches-list" } as never,
      params: { sessionKey: "agent:main:never-materialized" },
      respond,
      context: context(),
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(true, { branches: [] }, undefined);
  });

  it("lists branches and switches to an inactive tip", async () => {
    const listed = await invoke("sessions.branches.list");
    expect(listed).toHaveBeenCalledWith(
      true,
      {
        branches: [
          expect.objectContaining({
            leafEntryId: "assistant-entry",
            headline: "answer",
            messageCount: 2,
            active: true,
          }),
          expect.objectContaining({
            leafEntryId: "off-path-entry",
            headline: "inactive",
            messageCount: 1,
            active: false,
          }),
        ],
      },
      undefined,
    );

    const switched = await invoke("sessions.branches.switch", "off-path-entry");
    expect(switched).toHaveBeenCalledWith(true, {}, undefined);
  });

  it("clears queued session work after a successful branch switch", async () => {
    const work = enqueueSessionWork("branch switch");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.branches.switch", "off-path-entry");

    expect(respond).toHaveBeenCalledWith(true, {}, undefined);
    await expectSessionWorkCleared(work);
  });

  it("clears queued session work after a successful rewind", async () => {
    const work = enqueueSessionWork("rewind");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.rewind", "user-entry");

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ editorText: "edit me" }),
      undefined,
    );
    await expectSessionWorkCleared(work);
  });

  it("preserves queued session work after a rejected branch switch", async () => {
    const work = enqueueSessionWork("rejected branch switch");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.branches.switch", "missing");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("branch entry not found"),
      }),
    );
    expectSessionWorkQueued(work);

    setCommandLaneConcurrency(sessionLane, 1);
    await expect(work.command).resolves.toBe("rejected branch switch command");
    expect(work.hasCommandRun()).toBe(true);
  });

  it.each([
    ["missing", "branch entry not found"],
    ["user-entry", "entry is not a branch tip"],
    ["assistant-entry", "branch is already active"],
  ])("rejects invalid branch switch target %s", async (entryId, message) => {
    const respond = await invoke("sessions.branches.switch", entryId);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining(message),
      }),
    );
  });

  it("returns editor text for rewind and a new key for fork", async () => {
    const profileId = "profile-fork-creator";
    const fork = await invoke("sessions.fork", "user-entry", {
      connect: { scopes: ["operator.write"] },
      authenticatedUserProfile: {
        profileId,
        displayName: "Fork Operator",
        hasAvatar: false,
        updatedAt: 1,
      },
    } as GatewayClient);
    expect(fork).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        editorText: "edit me",
        editorAttachments: [
          { mimeType: "image/png", data: "aW1hZ2U=" },
          { mimeType: "image/png", data: storedImageData.toString("base64") },
        ],
        sessionKey: expect.any(String),
      }),
      undefined,
    );
    expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(2);
    const forkKey = (fork.mock.calls[0]?.[1] as { sessionKey?: string } | undefined)?.sessionKey;
    expect(forkKey).toBeTruthy();
    const forkEntry = loadSessionEntry({ agentId: "main", sessionKey: forkKey ?? "" });
    expect(forkEntry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: profileId },
      createdAt: expect.any(Number),
    });
    expect(listSessionStateEventsSince(forkKey ?? "", "main", 0, 20).events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        actorType: "human",
        actorId: profileId,
      }),
    );

    const rewind = await invoke("sessions.rewind", "user-entry");
    expect(rewind).toHaveBeenCalledWith(
      true,
      {
        editorText: "edit me",
        editorAttachments: [
          { mimeType: "image/png", data: "aW1hZ2U=" },
          { mimeType: "image/png", data: storedImageData.toString("base64") },
        ],
      },
      undefined,
    );
    expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing", "message entry not found"],
    ["assistant-entry", "entry is not a user message"],
    ["off-path-entry", "not on the active path"],
  ])("returns a typed validation error for %s", async (entryId, message) => {
    const respond = await invoke("sessions.rewind", entryId);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining(message),
      }),
    );
  });

  it("rejects mutation but lists empty branches for externally owned conversations", async () => {
    linkToUpstreamConversation();
    const respond = await invoke("sessions.branches.switch", "off-path-entry");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("external agent harness"),
      }),
    );
    // Listing is read-only: "no local branches" is the truthful steady state,
    // not an error to latch into the UI.
    const listed = await invoke("sessions.branches.list");
    expect(listed).toHaveBeenCalledWith(true, { branches: [] }, undefined);
  });

  it.each(["sessions.rewind", "sessions.branches.switch"] as const)(
    "rejects %s for upstream-linked sessions even with a fork-capable harness",
    async (method) => {
      linkToUpstreamConversation();
      installUpstreamForkHarness();
      const respond = await invoke(method, "user-entry");

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("external agent harness"),
        }),
      );
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
    },
  );

  it("delegates complete upstream fork materialization to the harness", async () => {
    linkToUpstreamConversation();
    installUpstreamForkHarness();
    mocks.upstreamFork.mockResolvedValue({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });

    const respond = await invoke("sessions.fork", "user-entry");
    expect(respond).toHaveBeenCalledWith(
      true,
      { editorText: "edit me", sessionKey: "agent:main:dashboard:forked" },
      undefined,
    );
    expect(mocks.upstreamFork).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ entryId: "user-entry", sessionKey }),
        targetKey: expect.stringMatching(/^agent:main:dashboard:/),
        upstream: expect.objectContaining({
          catalogId: "codex",
          hostId: "gateway:local",
          kind: "codex-app-server",
          threadId: "thread-source",
        }),
      }),
    );
  });

  it("does not mutate the local session when the upstream fork fails", async () => {
    linkToUpstreamConversation();
    installUpstreamForkHarness();
    mocks.upstreamFork.mockResolvedValue({
      status: "failed",
      code: "upstream-unavailable",
      message: "Codex is offline. Try again.",
    });

    const entryCount = listSessionEntriesCore({ agentId: "main" }).length;
    const respond = await invoke("sessions.fork", "user-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        details: { reason: "upstream-unavailable" },
      }),
    );
    expect(listSessionEntriesCore({ agentId: "main" })).toHaveLength(entryCount);
  });

  it.each(["steer-message", "in-progress-turn", "drift-mismatch"] as const)(
    "passes through the %s boundary failure",
    async (reason) => {
      linkToUpstreamConversation();
      installUpstreamForkHarness();
      mocks.upstreamFork.mockResolvedValue({
        status: "failed",
        code: reason,
        message: `boundary failed: ${reason}`,
      });

      const respond = await invoke("sessions.fork", "user-entry");

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          details: { reason },
          message: `boundary failed: ${reason}`,
        }),
      );
    },
  );

  it.each([
    ["sessions.fork", "Fork"],
    ["sessions.rewind", "Rewind"],
    ["sessions.branches.switch", "Branch switch"],
  ] as const)("rejects %s while the source run is active", async (method, label) => {
    const respond = await invoke(
      method,
      method === "sessions.branches.switch" ? "off-path-entry" : "user-entry",
      null,
      true,
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: `${label} is unavailable while the agent is working.`,
      }),
    );
  });
});
