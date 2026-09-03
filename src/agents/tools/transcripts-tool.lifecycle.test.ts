import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  it.each(["write failure", "shutdown"])(
    "releases the provider when title adoption encounters %s",
    async (fault) => {
      const h = harness();
      const entered = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      h.provider.start = async (request) => ({
        ok: true,
        session: { ...request.session, title: "Room" },
      });
      const originalWrite = h.store.writeSession.bind(h.store);
      let blocked = false;
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(async (session) => {
        if (session.title === "Room" && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
          if (fault === "write failure") {
            throw new Error("title write unavailable");
          }
        }
        return await originalWrite(session);
      });
      const start = h
        .createTool()
        .execute(
          "title-start",
          { action: "start", providerId: "capture", sessionId: "notes" },
          controller.signal,
        );
      const rejected = expect(start).rejects.toThrow(
        fault === "shutdown" ? "aborted" : "title write unavailable",
      );
      try {
        await entered.promise;
        if (fault === "shutdown") {
          controller.abort();
        }
      } finally {
        release.resolve();
      }
      await rejected;
      expect(h.provider.stop).toHaveBeenCalledOnce();
      expect((await h.session()).stoppedAt).toBeDefined();
      expect(await h.store.readSummary(await h.session())).toMatchObject({
        summary: { utteranceCount: 0 },
      });
      expect(activeSessions.has("notes")).toBe(false);
    },
  );

  it.each([undefined, "Operator title"])(
    "adopts only a bounded provider title when the caller title is %s",
    async (title) => {
      const h = harness();
      h.provider.start = async (request) => ({
        ok: true,
        session: {
          ...request.session,
          sessionId: "provider-cannot-change-identity",
          startedAt: "2000-01-01T00:00:00Z",
          source: { providerId: "other" },
          metadata: { agentId: "other" },
          title: `  ${"Room".repeat(40)}  `,
        },
      });
      await h.execute({ action: "start", providerId: "capture", sessionId: "notes", title });
      const stored = await h.session();
      expect(stored.title).toBe(title ?? "Room".repeat(30));
      expect(stored).toMatchObject({
        sessionId: "notes",
        source: { providerId: "capture" },
        metadata: { agentId: "research" },
      });
      expect(stored.startedAt).not.toBe("2000-01-01T00:00:00Z");
      await h.execute({ action: "stop", sessionId: "notes" });
    },
  );

  it.each(["stop", "summarize"] as const)(
    "rejects %s when its caller closes during provider policy",
    async (action) => {
      const h = harness();
      await h.start();
      let callerActive = true;
      const tool = h.createTool(() => {
        if (!callerActive) {
          throw new Error("caller ended");
        }
      });
      const entered = createDeferred();
      const release = createDeferred();
      h.provider.accessControl = {
        channelId: "capture-channel",
        resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
        authorize: async () => {
          entered.resolve();
          await release.promise;
          return { ok: true, value: undefined };
        },
      };
      const session = await h.session();
      const pending = tool.execute("closed-caller", {
        action,
        selector: `${session.startedAt.slice(0, 10)}/notes`,
      });
      const rejected = expect(pending).rejects.toThrow();
      try {
        await Promise.race([entered.promise, pending]);
        callerActive = false;
      } finally {
        release.resolve();
      }
      await rejected;
      expect(h.provider.stop).not.toHaveBeenCalled();
      expect((await h.session()).stoppedAt).toBeUndefined();
      expect(await h.store.readSummary(session)).toEqual({});
    },
  );

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
          details: {
            sessionId: "notes",
            selector: `${new Date().toISOString().slice(0, 10)}/notes`,
            active: false,
            stoppedAt: expect.any(String),
          },
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
          pendingFinalization: [
            {
              sessionId: "notes",
              selector: `${request.session.startedAt.slice(0, 10)}/notes`,
              stoppedAt: expect.any(String),
            },
          ],
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

  it.each(["inference", "commit"] as const)(
    "does not overwrite a completed reopen with a historical summary snapshot (%s)",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      await h.start();
      await h.requests[0]!.onUtterance({ text: "Original meeting" });
      await h.execute({ action: "stop", sessionId: "notes" });
      const session = await h.session();
      const entered = createDeferred();
      const release = createDeferred();
      const originalRead = h.store.readUtterancesForSession.bind(h.store);
      if (phase === "inference") {
        vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession").mockImplementationOnce(
          async (...args) => {
            const utterances = await originalRead(...args);
            entered.resolve();
            await release.promise;
            return utterances;
          },
        );
      } else {
        const originalWrite = h.store.writeSummary.bind(h.store);
        vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementationOnce(
          async (...args) => {
            entered.resolve();
            await release.promise;
            return originalWrite(...args);
          },
        );
      }
      const historical = h.execute({ action: "summarize", sessionId: "notes" });
      try {
        await Promise.race([entered.promise, historical]);
        await h.start();
        expect((await h.session()).startedAt).toBe(session.startedAt);
        await h.requests[1]!.onUtterance({ text: "Reopened meeting" });
        await h.execute({ action: "stop", sessionId: "notes" });
        release.resolve();
        await expect.soft(historical).resolves.toMatchObject({ details: { skipped: true } });
        expect(await h.store.readSummary(session)).toMatchObject({
          summary: { transcript: ["Original meeting", "Reopened meeting"] },
        });
      } finally {
        release.resolve();
        await Promise.allSettled([historical]);
        await h.execute({ action: "stop", sessionId: "notes" });
      }
    },
  );

  it("does not overwrite final notes with an older summary while stop exports them", async () => {
    const h = harness();
    await h.start();
    const session = await h.session();
    await h.requests[0]!.onUtterance({ text: "Before summary" });
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    const exportEntered = createDeferred();
    const releaseExport = createDeferred();
    const originalRead = h.store.readUtterancesForSession.bind(h.store);
    const originalExport = h.store.materializeSessionArtifacts.bind(h.store);
    vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession").mockImplementationOnce(
      async (...args) => {
        const utterances = await originalRead(...args);
        readEntered.resolve();
        await releaseRead.promise;
        return utterances;
      },
    );
    const summary = h.execute({ action: "summarize", sessionId: "notes" });
    let stop: ReturnType<typeof h.execute> | undefined;
    try {
      await readEntered.promise;
      await h.requests[0]!.onUtterance({ text: "Before stop" });
      vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts").mockImplementationOnce(
        async (...args) => {
          exportEntered.resolve();
          await releaseExport.promise;
          return originalExport(...args);
        },
      );
      stop = h.execute({ action: "stop", sessionId: "notes" });
      await exportEntered.promise;
      releaseRead.resolve();
      await expect(summary).resolves.toMatchObject({ details: { skipped: true } });
      expect(await h.store.readSummary(session)).toMatchObject({
        summary: { transcript: ["Before summary", "Before stop"] },
      });
    } finally {
      releaseRead.resolve();
      releaseExport.resolve();
      await Promise.allSettled([summary, stop]);
    }
  });

  it.each([
    { action: "stop", key: "sessionId" },
    { action: "stop", key: "selector" },
    { action: "summarize", key: "sessionId" },
    { action: "summarize", key: "selector" },
    { action: "status", key: "sessionId" },
  ] as const)(
    "revalidates capture identity after awaited $action authorization via $key without reusing startup authority",
    async ({ action, key }) => {
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
      const delayed = h.execute({
        action,
        ...(action !== "status"
          ? {
              [key]:
                key === "selector" ? `${new Date().toISOString().slice(0, 10)}/notes` : "notes",
            }
          : {}),
      });
      await Promise.race([entered, delayed]);
      callerActive = false;
      await h.requests[0]!.onStatus?.({ active: false });
      await h.start();
      const replacement = await h.session();
      const savedSummary = await h.store.readSummary(replacement);
      const read = vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession");
      const write = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
      const materialize = vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts");
      releaseAuthorization();
      await expect.soft(delayed).resolves.toMatchObject({
        details: action === "status" ? { active: [] } : { skipped: true },
      });
      expect.soft(read).not.toHaveBeenCalled();
      expect.soft(write).not.toHaveBeenCalled();
      expect.soft(materialize).not.toHaveBeenCalled();
      expect.soft(await h.store.readSummary(replacement)).toEqual(savedSummary);
      await expect.soft(fs.stat(h.store.sessionDir(replacement))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(h.provider.stop).not.toHaveBeenCalled();
      expect((await h.session()).stoppedAt).toBeUndefined();
      await h.execute({ action: "stop", sessionId: "notes" });
    },
  );

  it("does not persist or export a summary after its capture retires during the read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    await h.start();
    const session = await h.session();
    await h.requests[0]!.onUtterance({ text: "before retirement" });
    const entered = createDeferred();
    const release = createDeferred();
    const originalRead = h.store.readUtterancesForSession.bind(h.store);
    vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession").mockImplementationOnce(
      async (...args) => {
        const utterances = await originalRead(...args);
        entered.resolve();
        await release.promise;
        return utterances;
      },
    );
    const delayed = h.execute({
      action: "summarize",
      selector: `${session.startedAt.slice(0, 10)}/notes`,
    });
    try {
      await Promise.race([entered.promise, delayed]);
      await h.requests[0]!.onStatus?.({ active: false });
      await h.start();
      await h.requests[1]!.onUtterance({ text: "replacement note" });
    } finally {
      release.resolve();
    }
    const write = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
    const materialize = vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts");
    await expect.soft(delayed).resolves.toMatchObject({ details: { skipped: true } });
    expect.soft(write).not.toHaveBeenCalled();
    expect.soft(materialize).not.toHaveBeenCalled();
    await expect
      .soft(fs.stat(h.store.sessionDir(session)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await h.session()).stoppedAt).toBeUndefined();
    await h.execute({ action: "stop", sessionId: "notes" });
  });

  it.each([
    { phase: "active", fault: "missing" },
    { phase: "active", fault: "unreadable" },
    { phase: "terminal", fault: "missing" },
    { phase: "terminal", fault: "unreadable" },
  ] as const)("keeps $phase status visible with a $fault stored row", async ({ phase, fault }) => {
    const h = harness();
    await h.start();
    const session = await h.session();
    if (phase === "terminal") {
      const write = vi
        .spyOn(TranscriptsStore.prototype, "writeSession")
        .mockRejectedValueOnce(new Error("store unavailable"));
      await expect(h.requests[0]!.onStatus?.({ active: false })).rejects.toThrow(
        "store unavailable",
      );
      write.mockRestore();
    }
    const read = vi.spyOn(TranscriptsStore.prototype, "readSessionEntry");
    if (fault === "missing") {
      read.mockResolvedValue(undefined);
    } else {
      read.mockRejectedValue(new Error("row unreadable"));
    }
    await expect.soft(h.execute({ action: "status" })).resolves.toMatchObject({
      details: {
        [phase === "terminal" ? "pendingFinalization" : "active"]: [
          {
            sessionId: "notes",
            selector: `${session.startedAt.slice(0, 10)}/notes`,
          },
        ],
      },
    });
    expect.soft(read).not.toHaveBeenCalled();
    read.mockRestore();
    await h.execute({ action: "stop", sessionId: "notes" });
  });
});
