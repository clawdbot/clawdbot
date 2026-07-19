import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  active: false,
  external: false,
  queueClear: vi.fn(),
}));

vi.mock("../../auto-reply/reply/queue/cleanup.js", () => ({
  clearSessionQueues: mocks.queueClear,
}));

vi.mock("../../sessions/session-upstream-links.js", () => ({
  readSessionUpstreamLink: () => (mocks.external ? { upstreamKind: "external" } : undefined),
}));

vi.mock("./session-active-runs.js", () => {
  return { hasVisibleActiveSessionRun: () => mocks.active };
});

import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { sessionsHandlers } from "./sessions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:rewind-handler";

beforeEach(async () => {
  mocks.active = false;
  mocks.external = false;
  mocks.queueClear.mockReset();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-rewind-handler-"));
  await upsertSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: "rewind-handler-source",
      updatedAt: Date.now(),
    },
  );
  for (const event of [
    { type: "session", id: "rewind-handler-source", version: 3 },
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      message: { role: "user", content: "edit me" },
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
    const scope = { agentId: "main", sessionId: "rewind-handler-source", sessionKey };
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

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function context(): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

type MessageCutMethod =
  | "sessions.branches.list"
  | "sessions.branches.switch"
  | "sessions.fork"
  | "sessions.rewind";

async function invoke(method: MessageCutMethod, entryId?: string) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionsHandlers[method],
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
    respond,
    context: context(),
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("session message-cut methods", () => {
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
    expect(mocks.queueClear).toHaveBeenCalledOnce();
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
    const fork = await invoke("sessions.fork", "user-entry");
    expect(fork).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ editorText: "edit me", sessionKey: expect.any(String) }),
      undefined,
    );

    const rewind = await invoke("sessions.rewind", "user-entry");
    expect(rewind).toHaveBeenCalledWith(true, { editorText: "edit me" }, undefined);
    expect(mocks.queueClear).toHaveBeenCalledTimes(1);
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
    expect(mocks.queueClear).not.toHaveBeenCalled();
  });

  it("rejects externally owned conversations", async () => {
    mocks.external = true;
    const respond = await invoke("sessions.branches.switch", "off-path-entry");
    const listed = await invoke("sessions.branches.list");

    for (const response of [respond, listed]) {
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("external agent harness"),
        }),
      );
    }
  });

  it("returns a typed error for unsupported transcript storage", async () => {
    await upsertSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionFile: "/tmp/legacy-session.jsonl",
      },
    );
    const respond = await invoke("sessions.rewind", "user-entry");
    const listed = await invoke("sessions.branches.list");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("storage does not support rewind"),
      }),
    );
    expect(listed).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("storage does not support branch listing"),
      }),
    );
  });

  it.each([
    ["sessions.fork", "Fork"],
    ["sessions.rewind", "Rewind"],
    ["sessions.branches.switch", "Branch switch"],
  ] as const)("rejects %s while the source run is active", async (method, label) => {
    mocks.active = true;
    const respond = await invoke(
      method,
      method === "sessions.branches.switch" ? "off-path-entry" : "user-entry",
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: `${label} is unavailable while the agent is working.`,
      }),
    );
    expect(mocks.queueClear).not.toHaveBeenCalled();
  });
});
