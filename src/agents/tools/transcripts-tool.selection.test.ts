import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import { activeSessions } from "../../transcripts/capture.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getProvider,
  listTranscriptSourceProviders: () => [],
}));
const tempDirs = createTempDirTracker();
afterEach(() => {
  activeSessions.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function harness() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const stateDir = tempDirs.make("transcript-selection-");
  const requests: TranscriptStartRequest[] = [];
  const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
    async ({ source }) =>
      source.accountId === "private-account"
        ? { ok: false, error: "private provider reason" }
        : { ok: true, value: undefined },
  );
  const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
    ok: true,
    sessionId,
  }));
  const provider: TranscriptSourceProvider = {
    id: "capture",
    name: "Capture",
    sourceKinds: ["live-audio"],
    accessControl: {
      channelId: "capture",
      resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
      authorize,
    },
    start: async (request) => {
      requests.push(request);
      await request.onUtterance({ text: `Notes for ${request.session.sessionId}`, final: true });
      return { ok: true, session: request.session };
    },
    stop,
  };
  getProvider.mockReturnValue(provider);
  const ctx = {
    stateDir,
    agentId: "research",
    caller: { kind: "operator" as const, source: "local" as const },
    logger: { warn: vi.fn() },
  };
  const tool = createTranscriptsTool(ctx);
  const execute = (params: Record<string, unknown>) => tool.execute("selection", params);
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const start = async (id: string, date: string) => {
    vi.setSystemTime(new Date(`${date}T10:00:00.000Z`));
    return await execute({ action: "start", providerId: provider.id, sessionId: id });
  };
  const configuredCapture = (accountId: string) =>
    createTranscriptsAutoStartService({
      ...ctx,
      config: {
        transcripts: { autoStart: [{ providerId: "capture", sessionId: "notes", accountId }] },
      },
    });
  return { ctx, execute, start, configuredCapture, store, requests, stop, authorize };
}

const collision = [
  { sessionId: "2026-07-03/raw-id", date: "2026-07-04", selector: "2026-07-04/2026-07-03-raw-id" },
  { sessionId: "raw-id", date: "2026-07-03", selector: "2026-07-03/raw-id" },
];

describe("transcript tool selection", () => {
  it.each([false, true])(
    "rejects legacy collisions before and after retirement; reversed=%s",
    async (reverse) => {
      const h = harness();
      for (const target of reverse ? collision.toReversed() : collision) {
        await h.start(target.sessionId, target.date);
      }
      const rejectLegacy = async () => {
        h.authorize.mockClear();
        for (const action of ["stop", "summarize"]) {
          await expect(h.execute({ action, sessionId: collision[0]!.sessionId })).rejects.toThrow(
            /ambiguous.*selector/i,
          );
        }
        expect(h.authorize).not.toHaveBeenCalled();
      };
      await rejectLegacy();
      expect(h.stop).not.toHaveBeenCalled();
      for (const request of h.requests) {
        expect(await h.store.readSummary(request.session)).toEqual({});
        expect(
          (await h.store.readSession(transcriptSessionSelector(request.session)))?.stoppedAt,
        ).toBeUndefined();
        await expect(fs.stat(h.store.sessionDir(request.session))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const status = await h.execute({ action: "status" });
      expect(status).toMatchObject({
        details: {
          active: expect.arrayContaining(
            collision.map(({ sessionId, selector }) =>
              expect.objectContaining({ sessionId, selector }),
            ),
          ),
        },
      });
      const statusText = status.content.find((part) => part.type === "text")?.text ?? "";
      const shownSelectors = [...statusText.matchAll(/^active: (.+)$/gm)].map((match) => match[1]);
      expect(shownSelectors).toEqual(collision.map(({ selector }) => selector).toSorted());
      for (const target of collision) {
        const selector = shownSelectors.find((value) => value === target.selector);
        for (const action of ["summarize", "stop", "stop"]) {
          const result = await h.execute({ action, selector });
          expect(result).toMatchObject({
            details: {
              sessionId: target.sessionId,
              selector: target.selector,
              summary: {
                sessionId: target.sessionId,
                transcript: [`Notes for ${target.sessionId}`],
              },
            },
          });
          expect(result.content).toContainEqual({
            type: "text",
            text: expect.stringContaining(`Selector: ${target.selector}`),
          });
        }
        expect(h.stop.mock.calls.map(([request]) => request.sessionId)).toEqual(
          collision.slice(0, collision.indexOf(target) + 1).map(({ sessionId }) => sessionId),
        );
        await rejectLegacy();
      }
    },
  );

  it.each(["raw-id", "2026-07-03/raw-id"])(
    "prefers the current exact raw %s only without another identity",
    async (sessionId) => {
      const h = harness();
      for (const date of ["2026-07-01", "2026-07-02"]) {
        vi.setSystemTime(new Date(`${date}T10:00:00.000Z`));
        await h.execute({ action: "import", sessionId, transcript: `Historical ${date}` });
      }
      await h.start(sessionId, "2026-07-04");
      for (const action of ["summarize", "stop"]) {
        await expect(h.execute({ action, sessionId })).resolves.toMatchObject({
          details: {
            sessionId,
            summary: { transcript: [`Notes for ${sessionId}`] },
          },
        });
      }
      expect(h.stop).toHaveBeenCalledOnce();
      for (const action of ["summarize", "stop"]) {
        await expect(h.execute({ action, sessionId })).rejects.toThrow(/ambiguous.*selector/i);
        await expect(
          h.execute({ action, selector: `2026-07-01/${sessionId}` }),
        ).resolves.toMatchObject({
          details: { sessionId, summary: { transcript: ["Speaker: Historical 2026-07-01"] } },
        });
      }
      expect(h.stop).toHaveBeenCalledOnce();
    },
  );

  it("bounds model-visible status selectors without truncating recovery handles", async () => {
    const h = harness();
    const selectors: string[] = [];
    for (const index of [3, 2, 1, 0]) {
      const result = await h.start(`notes-${index}-${"x".repeat(900)}`, "2026-07-04");
      const text = result.content.find((part) => part.type === "text")?.text ?? "";
      const selector = text.match(/\nSelector: (.+)$/)?.[1];
      if (!selector) {
        throw new Error("Start must expose a complete selector to the model");
      }
      selectors.push(selector);
    }
    const failure = vi
      .spyOn(TranscriptsStore.prototype, "writeSession")
      .mockRejectedValueOnce(new Error("store unavailable"));
    await expect(h.requests[0]!.onStatus?.({ active: false })).rejects.toThrow("store unavailable");
    failure.mockRestore();

    const result = await h.execute({ action: "status" });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const shown = [...text.matchAll(/^(?:pending|active): (.+)$/gm)].map((match) => match[1]);
    expect(shown).toEqual([selectors[0], ...selectors.slice(1).toSorted().slice(0, 2)]);
    expect(text).toContain(`pending: ${selectors[0]}`);
    expect(text).toContain("1 more; ask a local operator to run openclaw transcripts list.");
    expect(text).toContain("\nSelectors:\n");
    expect(text.slice(text.indexOf("Selectors:")).length).toBeLessThanOrEqual(1024);
    expect(text).not.toContain("x".repeat(900));
    for (const selector of shown) {
      await expect(h.execute({ action: "summarize", selector })).resolves.toMatchObject({
        details: { selector },
      });
    }
  });

  it("does not hide a different slug identity behind repeated exact raw IDs", async () => {
    const h = harness();
    await h.start("foo-bar", "2026-07-04");
    for (const [sessionId, date] of [
      ["foo-bar", "2026-07-03"],
      ["foo@bar", "2026-07-01"],
    ] as const) {
      await h.store.writeSession({
        sessionId,
        startedAt: `${date}T10:00:00.000Z`,
        source: { providerId: "capture" },
        metadata: { agentId: "research" },
      });
    }
    for (const action of ["summarize", "stop"]) {
      await expect(h.execute({ action, sessionId: "foo-bar" })).rejects.toThrow(
        /ambiguous.*selector/i,
      );
    }
    expect(h.stop).not.toHaveBeenCalled();
  });

  it.each(["agent", "account"])(
    "never uses access denial to resolve a collision or disclose %s metadata",
    async (denial) => {
      const h = harness();
      await h.start(collision[0]!.sessionId, collision[0]!.date);
      const privateSession = {
        sessionId: "raw-id",
        startedAt: "2026-07-03T10:00:00.000Z",
        title: "private title",
        source: {
          providerId: "capture",
          accountId: denial === "account" ? "private-account" : "public-account",
        },
        metadata: { agentId: denial === "agent" ? "private-owner" : "research" },
      };
      await h.store.writeSession(privateSession);
      for (const action of ["stop", "summarize"]) {
        h.authorize.mockClear();
        await expect(h.execute({ action, sessionId: collision[0]!.sessionId })).rejects.toThrow(
          /^Ambiguous transcripts session; pass selector from start, import, status, or the local transcripts list\.$/,
        );
        expect(h.authorize).not.toHaveBeenCalled();
        await expect(h.execute({ action, selector: collision[1]!.selector })).rejects.toThrow(
          "transcripts session not found",
        );
        expect(h.authorize).toHaveBeenCalledTimes(denial === "account" ? 1 : 0);
      }
      expect(h.stop).not.toHaveBeenCalled();
      expect(await h.store.readSummary(privateSession)).toEqual({});
      await expect(h.execute({ action: "status" })).resolves.toMatchObject({
        details: {
          active: [{ sessionId: collision[0]!.sessionId, selector: collision[0]!.selector }],
        },
      });
    },
  );

  it.each(["start", "import", "status", "stop", "summarize"])(
    "validates selector admission before %s side effects",
    async (action) => {
      const h = harness();
      const rawParams = {
        action,
        sessionId: "notes",
        selector: "2026-07-03/notes",
        providerId: "capture",
        transcript: "do not import",
      };
      await expect(h.execute(rawParams)).rejects.toThrow(
        action === "stop" || action === "summarize"
          ? /exactly one.*selector.*sessionId/i
          : /selector.*only.*stop.*summarize/i,
      );
      if (action === "stop" || action === "summarize") {
        await expect(h.execute({ action })).rejects.toThrow(/exactly one.*selector.*sessionId/i);
      }
      expect(h.requests).toEqual([]);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.stop).not.toHaveBeenCalled();
      expect(await h.store.listSessionEntries()).toEqual([]);
    },
  );

  it("explicit selectors never fall back to a whole raw ID", async () => {
    const h = harness();
    await h.start(collision[0]!.sessionId, collision[0]!.date);
    for (const action of ["stop", "summarize"]) {
      await expect(h.execute({ action, selector: collision[0]!.sessionId })).rejects.toThrow(
        "transcripts session not found",
      );
    }
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("returns the canonical selector when starting and importing opaque IDs", async () => {
    const h = harness();
    await expect(h.start(collision[0]!.sessionId, collision[0]!.date)).resolves.toMatchObject({
      details: { sessionId: collision[0]!.sessionId, selector: collision[0]!.selector },
    });
    await expect(
      h.execute({ action: "import", sessionId: "notes: room/one", transcript: "retained" }),
    ).resolves.toMatchObject({
      details: { sessionId: "notes: room/one", selector: "2026-07-04/notes-room-one" },
    });
  });

  it("keeps configured cleanup bound to its lifecycle token despite a selector collision", async () => {
    const h = harness();
    await h.start(collision[1]!.sessionId, collision[1]!.date);
    vi.setSystemTime(new Date("2026-07-04T10:00:00.000Z"));
    const service = createTranscriptsAutoStartService({
      ...h.ctx,
      config: {
        transcripts: {
          autoStart: [
            {
              providerId: "capture",
              sessionId: collision[0]!.sessionId,
              accountId: "public-account",
            },
          ],
        },
      },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(activeSessions.has(collision[0]!.sessionId)).toBe(true));
      await service.stop();
      expect(h.stop.mock.calls.map(([request]) => request.sessionId)).toEqual([
        collision[0]!.sessionId,
      ]);
      await service.stop();
      expect(h.stop).toHaveBeenCalledOnce();
      expect(h.ctx.logger.warn).not.toHaveBeenCalled();
      expect(activeSessions.has(collision[1]!.sessionId)).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it.each(["missing", "unreadable"] as const)(
    "cleans up a configured provider without reading its $0 stored row",
    async (fault) => {
      const h = harness();
      const service = h.configuredCapture("public-account");
      try {
        service.start();
        await vi.waitFor(() => expect(activeSessions.has("notes")).toBe(true));
        const session = (await h.store.readSession("notes"))!;
        const read = vi.spyOn(TranscriptsStore.prototype, "readSessionEntry");
        if (fault === "missing") {
          read.mockResolvedValue(undefined);
        } else {
          read.mockRejectedValue(new Error("row unreadable"));
        }
        await service.stop();
        expect
          .soft(h.stop)
          .toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionId: "notes", source: session.source }),
          );
        expect.soft(read).not.toHaveBeenCalled();
        expect.soft(h.ctx.logger.warn).not.toHaveBeenCalled();
        read.mockRestore();
        expect.soft((await h.store.readSession("notes"))?.stoppedAt).toEqual(expect.any(String));
        expect
          .soft(await h.store.readSummary(session))
          .toMatchObject({ summary: { transcript: ["Notes for notes"] } });
      } finally {
        await service.stop();
      }
    },
  );

  it.each(["stop", "summarize", "service-stop"] as const)(
    "%s retains the admitted private source after a same-tuple public row rewrite",
    async (action) => {
      const h = harness();
      const service = h.configuredCapture("private-account");
      try {
        service.start();
        await vi.waitFor(() => expect(activeSessions.has("notes")).toBe(true));
        const session = (await h.store.readSession("notes"))!;
        const selector = transcriptSessionSelector(session);
        await h.store.writeSession({
          ...session,
          source: { ...session.source, accountId: "public-account" },
        });
        expect((await h.store.readSession(selector))?.source.accountId).toBe("public-account");
        h.authorize.mockClear();
        if (action !== "service-stop") {
          const read = vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession");
          const write = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
          const materialize = vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts");
          await expect
            .soft(h.execute({ action, selector }))
            .rejects.toThrow("transcripts session not found");
          expect
            .soft(h.authorize)
            .toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ action, source: session.source }),
            );
          expect.soft(h.stop).not.toHaveBeenCalled();
          expect.soft(read).not.toHaveBeenCalled();
          expect.soft(write).not.toHaveBeenCalled();
          expect.soft(materialize).not.toHaveBeenCalled();
          expect.soft(await h.store.readSummary(session)).toEqual({});
          expect.soft((await h.store.readSession(selector))?.stoppedAt).toBeUndefined();
          await expect
            .soft(fs.stat(h.store.sessionDir(session)))
            .rejects.toMatchObject({ code: "ENOENT" });
        }
        await service.stop();
        expect(h.stop).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionId: "notes", source: session.source }),
        );
        expect(await h.store.readSummary(session)).toMatchObject({
          summary: { transcript: ["Notes for notes"] },
        });
      } finally {
        await service.stop();
      }
    },
  );
});
