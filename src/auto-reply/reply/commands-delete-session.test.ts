import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayTransportError } from "../../gateway/call.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import {
  handleDeleteSessionCommand,
  parseDeleteSessionCommand,
} from "./commands-delete-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const DELETE_CALL_TIMEOUT_MS = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS + 45_000;

const callGatewayMock = vi.hoisted(() => vi.fn());
const admissionHandoffMock = vi.hoisted(() =>
  vi.fn((_params: { scope: string; identities: string[] }): string | undefined => undefined),
);

vi.mock("../../gateway/call.js", async () => ({
  ...(await vi.importActual<typeof import("../../gateway/call.js")>("../../gateway/call.js")),
  callGateway: (params: unknown) => callGatewayMock(params),
}));

vi.mock("../../sessions/session-lifecycle-admission.js", async () => ({
  ...(await vi.importActual<typeof import("../../sessions/session-lifecycle-admission.js")>(
    "../../sessions/session-lifecycle-admission.js",
  )),
  createSessionWorkAdmissionHandoffForCurrent: (params: { scope: string; identities: string[] }) =>
    admissionHandoffMock(params),
}));

const sessionKey = "agent:main:web:delete-me";
let tempRoots: string[] = [];

beforeEach(() => {
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ deleted: true });
  admissionHandoffMock.mockReset();
  admissionHandoffMock.mockReturnValue(undefined);
});

afterEach(async () => {
  clearSessionStoreCacheForTest();
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delete-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildDeleteParams(
  commandBodyNormalized: string,
  storePath: string,
  overrides: {
    gatewayClientScopes?: string[];
    isAuthorizedSender?: boolean;
    sessionKey?: string;
  } = {},
): HandleCommandsParams {
  const activeSessionKey = overrides.sessionKey ?? sessionKey;
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: "text",
      GatewayClientScopes: overrides.gatewayClientScopes,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: overrides.isAuthorizedSender ?? true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    sessionStore: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: activeSessionKey,
    storePath,
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("delete session command", () => {
  it("parses supported aliases and ignores other commands", () => {
    expect(parseDeleteSessionCommand("/close")).toEqual({ command: "/close", tail: "" });
    expect(parseDeleteSessionCommand("/DELETE now")).toEqual({ command: "/delete", tail: "now" });
    expect(parseDeleteSessionCommand("/name Demo")).toBeNull();
  });

  it("registers close/delete session commands", () => {
    const commands = buildBuiltinChatCommands();
    expect(commands.find((entry) => entry.key === "close")).toMatchObject({
      nativeName: "close",
      textAliases: ["/close"],
      category: "session",
    });
    expect(commands.find((entry) => entry.key === "delete-session")).toMatchObject({
      nativeName: "delete",
      textAliases: ["/delete"],
      category: "session",
    });
  });

  it("routes deletion through the gateway session lifecycle", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "delete-me",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    const params = buildDeleteParams("/close", storePath);

    callGatewayMock.mockResolvedValue({
      deleted: true,
      archived: ["/tmp/archive/delete-me.jsonl"],
    });
    const result = await handleDeleteSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ Session closed and archived." },
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
      params: { key: sessionKey, deleteTranscript: true },
    });
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("reports honest uncertainty when the gateway deletion call times out", async () => {
    // sessions.delete commits the lifecycle mutation before the worktree cleanup that
    // delays its response, so an expired client budget does not mean the close failed.
    // The reply must say so instead of claiming an error, and the local store entry
    // must survive untouched because the outcome is unconfirmed.
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildDeleteParams("/close", storePath);
    params.sessionStore = {
      [sessionKey]: { sessionId: "delete-me", updatedAt: 1, totalTokens: 0 },
    } as never;
    callGatewayMock.mockRejectedValue(
      new GatewayTransportError({
        kind: "timeout",
        timeoutMs: DELETE_CALL_TIMEOUT_MS,
        connectionDetails: { url: "ws://127.0.0.1:19001" } as never,
        message: "gateway request timed out",
      }),
    );

    const result = await handleDeleteSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Closing this session is taking longer than expected. The deletion may have completed with its cleanup still running; check the session list before retrying.",
      },
    });
    expect(params.sessionStore?.[sessionKey]).toBeDefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("rethrows non-timeout gateway failures from the deletion call", async () => {
    // Only the bounded-budget expiry gets the uncertainty reply; transport closures
    // and server errors keep propagating so callers surface them as real failures.
    const storePath = await createStorePath();
    const params = buildDeleteParams("/close", storePath);
    callGatewayMock.mockRejectedValue(new Error("gateway exploded"));

    await expect(handleDeleteSessionCommand(params, true)).rejects.toThrow("gateway exploded");
  });

  it("warns when the deleted session's worktree could not be removed", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "delete-me",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    callGatewayMock.mockResolvedValue({
      deleted: true,
      archived: ["/tmp/archive/delete-me.jsonl"],
      worktreePreserved: { id: "wt-1", branch: "feature/x", path: "/tmp/worktrees/wt-1" },
    });
    const params = buildDeleteParams("/close", storePath);

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const text = (result?.reply as { text: string }).text;
    expect(text).toContain("✅ Session closed and archived.");
    expect(text).toContain("worktree could not be removed");
    expect(text).toContain("feature/x");
    expect(text).toContain("/tmp/worktrees/wt-1");
  });

  it("reports closed without archived when the transcript was not archived", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    // Incognito sessions delete the transcript without archiving it: the gateway
    // returns an empty archived list, so the reply must not claim an archive.
    callGatewayMock.mockResolvedValue({ deleted: true, archived: [] });
    const params = buildDeleteParams("/close", storePath);

    const result = await handleDeleteSessionCommand(params, true);

    const text = (result?.reply as { text: string }).text;
    expect(text).toContain("was not archived");
    expect(text).not.toContain("closed and archived");
  });

  it("blocks transcript persistence for the /close success reply", async () => {
    const storePath = await createStorePath();
    const params = buildDeleteParams("/close", storePath);
    params.sessionStore = {
      [sessionKey]: {
        sessionId: "incarnation-1",
        lifecycleRevision: "rev-7",
        updatedAt: 42,
      },
    } as never;
    callGatewayMock.mockResolvedValue({
      deleted: true,
      archived: ["/tmp/archive/delete-me.jsonl"],
    });

    const result = await handleDeleteSessionCommand(params, true);

    const reply = result?.reply as object;
    const mirror = getReplyPayloadMetadata(reply)?.sourceReplyTranscriptMirror;
    expect(mirror?.transcriptWriteBlocked).toBe(true);
    expect(mirror?.sessionKey).toBe(sessionKey);
    expect(mirror?.expectedSessionId).toBe("incarnation-1");
  });

  it("binds the deletion to the captured session incarnation without pinning updatedAt", async () => {
    const storePath = await createStorePath();
    const params = buildDeleteParams("/close", storePath);
    params.sessionStore = {
      [sessionKey]: {
        sessionId: "incarnation-1",
        lifecycleRevision: "rev-7",
        updatedAt: 42,
      },
    } as never;

    await handleDeleteSessionCommand(params, true);

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
      params: {
        key: sessionKey,
        deleteTranscript: true,
        expectedSessionId: "incarnation-1",
        expectedLifecycleRevision: "rev-7",
      },
    });
    // updatedAt is bumped by metadata-only touches (labels, pins) without rotating
    // the session, so binding the deletion to it would spuriously fail /close.
    const call = callGatewayMock.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect(call.params).not.toHaveProperty("expectedSessionUpdatedAt");
  });

  it("forwards the initiating chat run id so the /close turn is not self-aborted", async () => {
    const storePath = await createStorePath();
    const params = buildDeleteParams("/close", storePath);
    params.opts = { runId: "run-close-42" } as never;

    await handleDeleteSessionCommand(params, true);

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({ exemptChatRunId: "run-close-42" }),
      }),
    );
  });

  it("omits exemptChatRunId when no initiating run id is available", async () => {
    const storePath = await createStorePath();
    const params = buildDeleteParams("/close", storePath);

    await handleDeleteSessionCommand(params, true);

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params: Record<string, unknown>;
    };
    expect(call.params).not.toHaveProperty("exemptChatRunId");
  });

  it("rejects delete command arguments instead of deleting the current session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "delete-me",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    const params = buildDeleteParams("/delete Planning notes", storePath);

    const result = await handleDeleteSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "/delete only deletes the current session and does not accept arguments." },
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });

  it("rejects unauthorized senders before leaking argument usage feedback", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildDeleteParams("/delete Planning notes", storePath, {
      isAuthorizedSender: false,
    });

    const result = await handleDeleteSessionCommand(params, true);

    // The authorization gate must run before argument validation so a probing
    // unauthorized sender gets the same silent rejection as for a bare /delete.
    expect(result).toEqual({ shouldContinue: false });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });

  it("hands off the admission under the normalized session key", async () => {
    const storePath = await createStorePath();
    admissionHandoffMock.mockReturnValueOnce("handoff-normalized");
    const params = buildDeleteParams("/close", storePath);

    await handleDeleteSessionCommand(params, true);

    expect(admissionHandoffMock).toHaveBeenCalledTimes(1);
    expect(admissionHandoffMock).toHaveBeenCalledWith({
      scope: storePath,
      identities: [sessionKey],
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          key: sessionKey,
          admissionHandoffId: "handoff-normalized",
        }),
      }),
    );
  });

  it("falls back to the raw-key admission handoff and targets the RPC at that key", async () => {
    const storePath = await createStorePath();
    // The turn admission is registered under the RAW session key; when it differs
    // from the normalized key (e.g. legacy casing) the normalized handoff misses.
    const rawSessionKey = "agent:main:web:Delete-ME";
    admissionHandoffMock.mockImplementation((handoff: { identities: string[] }) =>
      handoff.identities[0] === rawSessionKey ? "handoff-raw" : undefined,
    );
    const params = buildDeleteParams("/close", storePath, { sessionKey: rawSessionKey });

    await handleDeleteSessionCommand(params, true);

    expect(admissionHandoffMock).toHaveBeenNthCalledWith(1, {
      scope: storePath,
      identities: [sessionKey],
    });
    expect(admissionHandoffMock).toHaveBeenNthCalledWith(2, {
      scope: storePath,
      identities: [rawSessionKey],
    });
    // The server consumes the handoff with the key it receives, so the RPC must
    // target the same key the handoff was created for or the lease is never adopted.
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          key: rawSessionKey,
          admissionHandoffId: "handoff-raw",
        }),
      }),
    );
  });

  it("does not delete the main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:main:main" });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.sessionId).toBe(
      "main-session",
    );
  });

  it("does not delete another agent main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:work:main" },
      {
        sessionId: "work-main-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:work:main" });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: "agent:work:main" })?.sessionId).toBe(
      "work-main-session",
    );
  });

  it("does not delete another agent configured main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:work:home" },
      {
        sessionId: "work-home-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    );
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:work:home" });
    params.cfg = { session: { mainKey: "home" } } as OpenClawConfig;

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: "agent:work:home" })?.sessionId).toBe(
      "work-home-session",
    );
  });

  it("does not delete for an unauthorized sender", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildDeleteParams("/close", storePath, { isAuthorizedSender: false });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });

  it("requires operator.admin for internal gateway clients", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );
    const params = buildDeleteParams("/close", storePath, {
      gatewayClientScopes: ["operator.write"],
    });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("operator.admin");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });
});
