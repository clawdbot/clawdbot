import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { activeSessions } from "./transcripts-tool-runtime.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getProvider,
  listTranscriptSourceProviders: () => [],
}));
const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function harness() {
  const stateDir = tempDirs.make("transcript-lifecycle-");
  const requests: TranscriptStartRequest[] = [];
  const logger = { warn: vi.fn() };
  const provider: TranscriptSourceProvider = {
    id: "capture",
    name: "Capture",
    sourceKinds: ["live-audio"],
    start: vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      requests.push(request);
      return { ok: true, session: request.session };
    }),
    stop: vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async (request) => ({
      ok: true,
      sessionId: request.sessionId,
    })),
  };
  getProvider.mockReturnValue(provider);
  const createTool = (assertCallerActive?: () => void) =>
    createTranscriptsTool({
      config: { transcripts: { enabled: true } },
      stateDir,
      agentId: "research",
      logger,
      caller: { kind: "operator", source: "local" },
      assertCallerActive,
    });
  const tool = createTool();
  const execute = (params: Record<string, unknown>) => tool.execute("lifecycle", params);
  const start = () =>
    execute({
      action: "start",
      providerId: provider.id,
      sessionId: "notes",
      accountId: "admitted",
      meetingUrl: "https://meeting.example/room?private=opaque#fragment",
    });
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const session = async () => {
    const value = await store.readSession("notes");
    if (!value) {
      throw new Error("missing capture");
    }
    return value;
  };
  return { stateDir, requests, logger, provider, createTool, execute, start, store, session };
}

describe("transcript capture ownership", () => {
  it.each(["terminal", "rejected", "thrown"] as const)(
    "fences a %s startup and its retained callbacks after same-millisecond id reuse",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      let retained!: TranscriptStartRequest;
      h.provider.start = async (request) => {
        retained = request;
        await request.onUtterance({ text: "before closure" });
        await request.onStatus?.({
          active: false,
          sessionId: "another-id",
          source: { providerId: "other", accountId: "other" },
        });
        await request.onStatus?.({ active: true });
        await request.onUtterance({ text: "after closure" });
        if (outcome === "thrown") {
          throw new Error("start failed");
        }
        return outcome === "rejected"
          ? { ok: false, error: "start failed" }
          : {
              ok: true,
              session: {
                ...request.session,
                source: { providerId: "other" },
                metadata: { agentId: "other" },
              },
            };
      };
      if (outcome === "terminal") {
        await expect(h.start()).resolves.toMatchObject({
          details: { sessionId: "notes", active: false, stoppedAt: expect.any(String) },
        });
        expect(await h.store.readSummary(await h.session())).toMatchObject({
          summary: { utteranceCount: 1 },
        });
        await expect(fs.stat(h.store.sessionDir(await h.session()))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        await expect(h.start()).rejects.toThrow("start failed");
      }
      await expect(h.execute({ action: "status" })).resolves.toMatchObject({
        details: { active: [] },
      });
      const first = await h.session();
      expect(first).toMatchObject({
        source: {
          providerId: "capture",
          accountId: "admitted",
          agentId: "research",
          meetingUrl: "https://meeting.example/room",
        },
        metadata: { agentId: "research" },
      });
      h.provider.start = async (request) => ({ ok: true, session: request.session });
      await h.start();
      await retained.onStatus?.({ active: false, sessionId: "notes" });
      await retained.onUtterance({ text: "stale callback after reuse" });
      const replacement = await h.session();
      expect(replacement.startedAt).toBe(first.startedAt);
      expect(replacement.stoppedAt).toBeUndefined();
      expect((await h.store.readUtterancesForSession(replacement)).map((row) => row.text)).toEqual([
        "before closure",
      ]);
      await expect(h.execute({ action: "status" })).resolves.toMatchObject({
        details: { active: [{ sessionId: "notes" }] },
      });
      expect(h.provider.stop).not.toHaveBeenCalled();
      await h.execute({ action: "stop", sessionId: "notes" });
    },
  );

  it.each(["inline", "microtask", "after-stop"] as const)(
    "shares durable finalization with an explicit stop notification delivered %s",
    async (ordering) => {
      const h = harness();
      await h.start();
      const request = h.requests[0]!;
      await request.onUtterance({ text: "final audio" });
      const writeSession = vi.spyOn(TranscriptsStore.prototype, "writeSession");
      const writeSummary = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
      const terminal = () => request.onStatus?.({ active: false });
      let notification: Promise<void> | undefined;
      h.provider.stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async () => {
        if (ordering === "inline") {
          await terminal();
        }
        if (ordering === "microtask") {
          notification = Promise.resolve().then(terminal);
        }
        return { ok: true, sessionId: "notes" };
      });
      await expect(h.execute({ action: "stop", sessionId: "notes" })).resolves.toMatchObject({
        details: { summary: { utteranceCount: 1 } },
      });
      await notification;
      if (ordering === "after-stop") {
        await terminal();
      }
      await request.onUtterance({ text: "too late" });
      expect(writeSession).toHaveBeenCalledOnce();
      expect(writeSummary).toHaveBeenCalledOnce();
      const stoppedAt = (await h.session()).stoppedAt;
      await h.execute({ action: "stop", sessionId: "notes" });
      expect((await h.session()).stoppedAt).toBe(stoppedAt);
      expect(h.provider.stop).toHaveBeenCalledOnce();
      expect(
        (await h.store.readUtterancesForSession(await h.session())).map((row) => row.text),
      ).toEqual(["final audio"]);
    },
  );

  it.each(["writeSession", "readUtterancesForSession", "writeSummary"] as const)(
    "exposes terminal %s failures and recovers without another provider stop",
    async (operation) => {
      const h = harness();
      await h.start();
      const request = h.requests[0]!;
      await request.onUtterance({ text: "retained note" });
      const failure = vi
        .spyOn(TranscriptsStore.prototype, operation)
        .mockRejectedValueOnce(new Error("store unavailable"));
      await expect(request.onStatus?.({ active: false })).rejects.toThrow("store unavailable");
      failure.mockRestore();
      await request.onUtterance({ text: "retired audio" });
      await expect(h.execute({ action: "status" })).resolves.toMatchObject({
        details: {
          active: [],
          pendingFinalization: [{ sessionId: "notes", stoppedAt: expect.any(String) }],
        },
      });
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("use transcripts stop to retry"),
      );
      await expect(h.start()).rejects.toThrow("already active");
      await expect(h.execute({ action: "stop", sessionId: "notes" })).resolves.toMatchObject({
        details: { summary: { utteranceCount: 1 } },
      });
      expect(h.provider.stop).not.toHaveBeenCalled();
      expect((await h.session()).stoppedAt).toEqual(expect.any(String));
      await expect(h.execute({ action: "status" })).resolves.toMatchObject({
        details: { active: [], pendingFinalization: [] },
      });
    },
  );

  it.each(["stop", "status"] as const)(
    "revalidates capture identity after awaited %s authorization without reusing startup authority",
    async (action) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      let callerActive = true;
      const startingTool = h.createTool(() => {
        if (!callerActive) {
          throw new Error("starting run ended");
        }
      });
      let authorizeEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        authorizeEntered = resolve;
      });
      let releaseAuthorization!: () => void;
      const authorization = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      let delayAuthorization = true;
      h.provider.accessControl = {
        channelId: "capture-channel",
        resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
        authorize: async (request) => {
          if (request.action === action && delayAuthorization) {
            delayAuthorization = false;
            authorizeEntered();
            await authorization;
          }
          return { ok: true, value: undefined };
        },
      };
      await startingTool.execute("start", {
        action: "start",
        providerId: "capture",
        sessionId: "notes",
      });
      const delayed = h.execute({ action, sessionId: "notes" });
      await entered;
      callerActive = false;
      await h.requests[0]!.onStatus?.({ active: false });
      await h.start();
      releaseAuthorization();
      await expect(delayed).resolves.toMatchObject({
        details: action === "stop" ? { skipped: true } : { active: [] },
      });
      expect(h.provider.stop).not.toHaveBeenCalled();
      expect((await h.session()).stoppedAt).toBeUndefined();
      await h.execute({ action: "stop", sessionId: "notes" });
    },
  );
});
