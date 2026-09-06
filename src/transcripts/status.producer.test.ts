import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../gateway/config-reload-plan.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { activeSessions, readTranscriptCaptureSnapshot, startTranscripts } from "./capture.js";
import * as providerRegistry from "./provider-registry.js";
import type { TranscriptOccupancyWatchRequest, TranscriptStartRequest } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();

describe("configured transcript source provenance", () => {
  it.each([
    { name: "direct title edit", titles: ["Future title"], unrelated: false },
    { name: "logging then title", titles: ["Future title"], unrelated: true },
    { name: "successive reloads", titles: ["First title", "Latest title"], unrelated: true },
    { name: "title removal", titles: ["First title", undefined], unrelated: true },
  ])(
    "uses the published future title after $name with original routing authority",
    async ({ titles, unrelated }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const source = { ...room, title: "Before", sessionId: "future-title" };
      const f = fixture({
        logging: { level: "info" },
        agents: { entries: { main: {}, notes: {}, other: {} } },
        bindings: [{ agentId: "notes", match: { channel: "discord", accountId: room.accountId } }],
        transcripts: { autoStart: [source] },
      });
      let current = f.ctx.config;
      setRuntimeConfigSnapshot(current, current);
      const publish = (candidate: OpenClawConfig) => {
        const plan = buildGatewayReloadPlan(
          diffGatewayReloadPaths(current, candidate, listConfigReloadRefinementPrefixes()),
          {
            previousConfig: current,
            candidateConfig: candidate,
          },
        );
        expect(isNoopGatewayReloadPlan(plan)).toBe(true);
        setRuntimeConfigSnapshot(candidate, candidate);
        current = candidate;
      };
      vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(undefined);
      const start = vi.fn(f.provider.start!);
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(
        { ...f.ctx, agentId: undefined },
        () => getRuntimeConfigSnapshot() ?? undefined,
      );
      try {
        service.start();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying"),
        );
        expect(await f.store.listSessionEntries()).toHaveLength(0);
        for (const [index, title] of titles.entries()) {
          if (unrelated) {
            publish({ ...current, logging: { level: index === 0 ? "debug" : "warn" } });
            publish({
              ...current,
              bindings: [
                { agentId: "other", match: { channel: "discord", accountId: room.accountId } },
              ],
            });
          }
          const { title: _title, ...intent } = source;
          publish({
            ...current,
            transcripts: { autoStart: [{ ...intent, ...(title === undefined ? {} : { title }) }] },
          });
          await vi.advanceTimersByTimeAsync(5_000);
          expect(start).not.toHaveBeenCalled();
          expect(await f.store.listSessionEntries()).toHaveLength(0);
        }
        vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(f.provider);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(async () => expect((await f.read()).active).toHaveLength(1));
        expect(start).toHaveBeenCalledTimes(1);
        const request = start.mock.calls[0]![0];
        expect(request.cfg).toBe(f.ctx.config);
        expect(request.session).toMatchObject({
          sessionId: source.sessionId,
          title: titles.at(-1),
          source: { ...room, agentId: "notes" },
          metadata: { agentId: "notes" },
        });
        await expect(f.store.readSession(source.sessionId)).resolves.toEqual(request.session);
      } finally {
        await service.stop();
      }
    },
  );
  it.each([
    ["full invitation", { meetingUrl: "https://example.test/room?invitation=other-private" }],
    ["unknown provider field", { providerOptions: { mode: "other" } }],
    ["explicit omitted field", { channelId: undefined }],
  ])("does not borrow a retry title from changed %s intent", async (_name, changed) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const source = {
      ...room,
      sessionId: "original-intent",
      title: "Before",
      meetingUrl: "https://example.test/room?invitation=synthetic-private",
      providerOptions: { mode: "original" },
    };
    const f = fixture({ transcripts: { autoStart: [source] } });
    let current = f.ctx.config;
    vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(undefined);
    const start = vi.fn(f.provider.start!);
    f.provider.start = start;
    const service = createTranscriptsAutoStartService(f.ctx, () => current);
    try {
      service.start();
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying"),
      );
      current = { transcripts: { autoStart: [{ ...source, ...changed, title: "Ineligible" }] } };
      vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(f.provider);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const request = start.mock.calls[0]![0];
      expect(request.cfg).toBe(f.ctx.config);
      expect(request.session).toMatchObject({
        title: "Before",
        source: { ...room, meetingUrl: source.meetingUrl, agentId: "main" },
      });
      await expect(f.store.readSession(source.sessionId)).resolves.toMatchObject({
        title: "Before",
        source: { ...room, meetingUrl: "https://example.test/room", agentId: "main" },
      });
    } finally {
      await service.stop();
    }
  });
  it("reports only its exact configured URL attempt and keeps changed invitations uncertain", async () => {
    const source = {
      ...room,
      meetingUrl: "https://example.test/room?invitation=synthetic-private",
    };
    const f = fixture({ transcripts: { autoStart: [source] } });
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      service.start();
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources[0]?.state).toBe("armed"),
      );
      const changed = await readTranscriptLibraryStatus(f.store, {
        transcripts: {
          autoStart: [
            { ...source, meetingUrl: "https://example.test/room?invitation=other-private" },
          ],
        },
      });
      expect(changed.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
      expect(changed.configuredSources[0]).not.toHaveProperty("startDiagnostic");
      expect(JSON.stringify([await f.read(), changed])).not.toMatch(
        /synthetic-private|other-private/,
      );
    } finally {
      await service.stop();
    }
  });

  it("bounds unavailable-start diagnostics and clears them with their service", async () => {
    const f = fixture({
      transcripts: {
        autoStart: Array.from({ length: 101 }, (_, index) => ({
          ...room,
          sessionId: `source-${index}`,
        })),
      },
    });
    vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(undefined);
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      service.start();
      await vi.waitFor(async () =>
        expect(
          (await f.read()).configuredSources.every(
            (source) => source.startDiagnostic === "retrying",
          ),
        ).toBe(true),
      );
      const result = await f.read();
      expect(result.configuredSources).toHaveLength(100);
      expect(result.omitted.configuredSources).toBe(1);
      await service.stop();
      expect(
        (await f.read()).configuredSources.every((source) => source.startDiagnostic === undefined),
      ).toBe(true);
    } finally {
      await service.stop();
    }
  });
  it.each([
    ...(["throw", "reject"] as const).flatMap((outcome) => [
      { outcome, fixed: true, title: "Original", failures: 12 },
      { outcome, fixed: false, title: "Original", failures: 2 },
      { outcome, fixed: false, title: undefined, failures: 1 },
    ]),
    { outcome: "reject", fixed: false, title: undefined, failures: 12 },
  ])(
    "retains admission and notes after $outcome (fixed=$fixed, title=$title, failures=$failures)",
    async ({ outcome, fixed, title, failures }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const source = { ...room, sessionId: fixed ? "failed-admission" : undefined, title };
      const f = fixture({
        transcripts: { autoStart: [source] },
      });
      let current = f.ctx.config;
      const start = vi.fn(async (candidate: TranscriptStartRequest) => {
        await candidate.onUtterance({ text: `Valid note ${start.mock.calls.length}`, final: true });
        if (start.mock.calls.length > failures) {
          return {
            ok: true as const,
            session: { ...candidate.session, title: "Provider title after retry" },
          };
        }
        if (outcome === "throw") {
          throw new Error("synthetic-secret https://example.test/?invite=private /private/stack");
        }
        return {
          ok: false as const,
          error: "synthetic-secret https://example.test/?invite=private",
        };
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx, () => current);
      try {
        service.start();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]).toMatchObject({
            startDiagnostic: "retrying",
            state: "unknown",
          }),
        );
        const request = start.mock.calls[0]![0];
        const admitted = structuredClone(request.session);
        const before = await f.store.readSession(admitted.sessionId);
        current = { transcripts: { autoStart: [{ ...source, title: "Future title" }] } };
        await vi.advanceTimersByTimeAsync(65_000);
        const attempts = Math.min(failures + 1, 12);
        expect(start).toHaveBeenCalledTimes(attempts);
        for (const [candidate] of start.mock.calls) {
          expect(candidate.session).toEqual(admitted);
        }
        await request.onUtterance({ text: "Stale callback", final: true });
        await expect(f.store.readUtterancesForSession(admitted)).resolves.toMatchObject(
          Array.from({ length: attempts }, (_, index) => ({ text: `Valid note ${index + 1}` })),
        );
        const { stoppedAt: _stoppedAt, ...running } = before!;
        await expect(f.store.readSession(admitted.sessionId)).resolves.toEqual(
          failures < 12 ? running : before,
        );
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        const configured = (await f.read()).configuredSources[0];
        expect(configured?.state).toBe(failures < 12 ? "armed" : "not-active");
        if (failures < 12) {
          expect(configured).not.toHaveProperty("startDiagnostic");
        } else {
          expect(configured?.startDiagnostic).toBe("start-failed");
        }
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(attempts);
        expect(JSON.stringify([await f.read(), f.ctx.logger.warn.mock.calls])).not.toMatch(
          /synthetic-secret|invite=private|\/private\/stack|UNIQUE/,
        );
      } finally {
        await service.stop();
      }
    },
  );

  it.each(
    (["returned-stop", "thrown-stop", "session-write", "summary-write"] as const).flatMap((fault) =>
      ["fixed", "generated"].map((identity) => ({ fault, identity })),
    ),
  )(
    "retains failed startup cleanup custody after $fault ($identity identity)",
    async ({ fault, identity }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({
        transcripts: {
          autoStart: [{ ...room, sessionId: identity === "fixed" ? "retained" : undefined }],
        },
      });
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({ text: "Admitted note", final: true });
        return { ok: true as const, session: { ...request.session, title: "Room title" } };
      });
      f.provider.start = start;
      const stop = vi.spyOn(f.provider, "stop");
      const originalWrite = f.store.writeSession.bind(f.store);
      let titleFailed = false;
      let cleanupFails = true;
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(async (session) => {
        if (session.title === "Room title" && !titleFailed) {
          titleFailed = true;
          throw new Error("title write unavailable");
        }
        if (session.stoppedAt && fault === "session-write" && cleanupFails) {
          throw new Error("final session write unavailable");
        }
        await originalWrite(session);
      });
      const originalSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (fault === "summary-write" && cleanupFails) {
          throw new Error("summary write unavailable");
        }
        return originalSummary(...args);
      });
      stop.mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "returned-stop") {
          return { ok: false, error: "cleanup unavailable" };
        }
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).not.toBe("starting"),
        );
        await vi.advanceTimersByTimeAsync(65_000);
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).not.toBe("starting"),
        );
        expect.soft(start).toHaveBeenCalledOnce();
        expect.soft(await f.store.listSessionEntries()).toHaveLength(1);
        expect
          .soft((await f.read()).configuredSources[0]?.startDiagnostic)
          .toBe("admitted-start-failed");
        const request = start.mock.calls.at(-1)![0];
        const session = request.session;
        await request.onUtterance({ text: "Late failed-start note", final: true });
        const terminal = fault === "session-write" || fault === "summary-write";
        await expect(f.tool.execute("status", { action: "status" })).resolves.toMatchObject({
          details: {
            [terminal ? "pendingFinalization" : "active"]: [
              expect.objectContaining({ sessionId: session.sessionId }),
            ],
          },
        });
        const otherConfig = {
          transcripts: { autoStart: [{ ...room, sessionId: session.sessionId }] },
        };
        const other = createTranscriptsAutoStartService({ ...f.ctx, config: otherConfig });
        try {
          other.start();
          await vi.waitFor(async () =>
            expect(
              (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
                ?.startDiagnostic,
            ).toBe("id-conflict"),
          );
        } finally {
          await other.stop();
        }
        expect.soft(stop).toHaveBeenCalledOnce();
        await service.stop();
        cleanupFails = false;
        // A failed shutdown still owns cleanup; another stop drains that same owner.
        await service.stop();
        expect.soft(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect.soft(activeSessions.has(session.sessionId)).toBe(false);
        const stored = (await f.store.readSession(session.sessionId))!;
        expect.soft(stored).toMatchObject({
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          title: "Room title",
          stoppedAt: expect.any(String),
        });
        expect.soft(stored.source).toEqual(session.source);
        expect.soft(await f.store.readSummary(stored)).toMatchObject({
          summary: { transcript: ["Admitted note"] },
        });
      } finally {
        cleanupFails = false;
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", { action: "stop", sessionId: request.session.sessionId });
        }
      }
    },
  );

  it.each(
    [false, true].flatMap((whenOccupied) =>
      ["returned-stop", "thrown-stop", "session-write", "summary-write"].map((fault) => ({
        whenOccupied,
        fault,
      })),
    ),
  )(
    "retains and drains late $fault after shutdown (occupied=$whenOccupied)",
    async ({ whenOccupied, fault }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied }] } });
      const watches: TranscriptOccupancyWatchRequest[] = [];
      const unwatch = vi.fn();
      f.provider.watchOccupancy = async (request) => {
        watches.push(request);
        request.onOccupied();
        return { ok: true, value: { stop: unwatch } };
      };
      const gate = createDeferred();
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({ text: "Before shutdown" });
        await gate.promise;
        await request.onUtterance({ text: "After shutdown" });
        return { ok: true as const, session: { ...request.session, title: "Late title" } };
      });
      f.provider.start = start;
      let cleanupFails = true;
      const stop = vi.spyOn(f.provider, "stop").mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "returned-stop") {
          return { ok: false, error: "cleanup unavailable" };
        }
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const writeSession = f.store.writeSession.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(async (session) => {
        if (cleanupFails && fault === "session-write" && session.stoppedAt) {
          throw new Error("final session unavailable");
        }
        await writeSession(session);
      });
      const writeSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (cleanupFails && fault === "summary-write") {
          throw new Error("summary unavailable");
        }
        return writeSummary(...args);
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        const request = start.mock.calls[0]![0];
        const session = request.session;
        const stopping = service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
        expect(unwatch).toHaveBeenCalledTimes(whenOccupied ? 1 : 0);
        expect(request.abortSignal?.aborted).toBe(true);
        gate.resolve();
        // A failed late drain must be visible and still owned after startup settles.
        await vi.waitFor(() =>
          expect(f.ctx.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("transcripts autoStart session="),
          ),
        );
        const terminal = fault === "session-write" || fault === "summary-write";
        await expect(f.tool.execute("status", { action: "status" })).resolves.toMatchObject({
          details: {
            [terminal ? "pendingFinalization" : "active"]: [
              expect.objectContaining({ sessionId: session.sessionId }),
            ],
          },
        });
        const otherConfig = {
          transcripts: { autoStart: [{ ...room, sessionId: session.sessionId }] },
        };
        const other = createTranscriptsAutoStartService({ ...f.ctx, config: otherConfig });
        try {
          other.start();
          await vi.waitFor(async () =>
            expect(
              (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
                ?.startDiagnostic,
            ).toBe("id-conflict"),
          );
        } finally {
          await other.stop();
        }
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 2);
        cleanupFails = false;
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect(activeSessions.has(session.sessionId)).toBe(false);
        expect((await f.store.readSession(session.sessionId))?.stoppedAt).toEqual(
          expect.any(String),
        );
        expect(await f.store.readSummary(session)).toMatchObject({
          summary: { transcript: ["Before shutdown"] },
        });
        watches[0]?.onEmpty();
        watches[0]?.onOccupied();
        await request.onUtterance({ text: "Retired callback" });
        await request.onStatus?.({ active: false });
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        expect(await f.store.readUtterancesForSession(session)).toMatchObject([
          { text: "Before shutdown" },
        ]);
        // Even the same raw ID on a later day belongs to a distinct lifecycle.
        vi.setSystemTime(new Date(Date.parse(session.startedAt) + 86_400_000));
        await f.start({ ...room, sessionId: session.sessionId });
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect((await f.read()).active).toMatchObject([
          { sessionId: session.sessionId, activeSubscription: true },
        ]);
      } finally {
        cleanupFails = false;
        gate.resolve();
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", {
            action: "stop",
            selector: transcriptSessionSelector(request.session),
          });
        }
      }
    },
  );

  it.each(["queued", "pending", "manual"] as const)(
    "cancels generated retries after %s stop",
    async (mode) => {
      const pending = mode === "pending";
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture();
      const gate = createDeferred();
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        if (start.mock.calls.length === 1) {
          return { ok: false as const, error: "temporary provider failure" };
        }
        await gate.promise;
        return { ok: true as const, session: request.session };
      });
      f.provider.start = start;
      const stop = vi.spyOn(f.provider, "stop");
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying"),
        );
        if (pending) {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(start).toHaveBeenCalledTimes(2);
        }
        const session = start.mock.calls[0]![0].session;
        if (mode === "manual") {
          await f.tool.execute("stop", { action: "stop", sessionId: session.sessionId });
        } else {
          const stopping = service.stop();
          if (pending) {
            expect(start.mock.calls[1]![0].abortSignal?.aborted).toBe(true);
          }
          gate.resolve();
          await stopping;
        }
        const stoppedSession = await f.store.readSession(session.sessionId);
        gate.resolve();
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(pending ? 2 : 1);
        expect(stop).toHaveBeenCalledTimes(pending ? 1 : 0);
        for (const [request] of start.mock.calls) {
          await request.onUtterance({ text: "late cancelled note", final: true });
          await expect(f.store.readUtterancesForSession(request.session)).resolves.toEqual([]);
        }
        expect((await f.read()).active).toEqual([]);
        if (mode === "manual") {
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("id-conflict");
        } else {
          expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
        }
        expect(await f.store.readSession(session.sessionId)).toEqual(stoppedSession);
        expect(await f.store.listSessionEntries()).toHaveLength(1);
      } finally {
        gate.resolve();
        await service.stop();
      }
    },
  );

  it("retries unavailable providers only before admission and distinguishes duplicate configured entries", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entry = { ...room, sessionId: "daily" };
    const f = fixture({ transcripts: { autoStart: [entry, entry] } });
    vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(undefined);
    const start = vi.fn(f.provider.start!);
    f.provider.start = start;
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      service.start();
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources.map((s) => s.startDiagnostic)).toEqual([
          "retrying",
          "retrying",
        ]),
      );
      expect(await f.store.listSessionEntries()).toHaveLength(0);
      vi.mocked(providerRegistry.getTranscriptSourceProvider).mockReturnValue(f.provider);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources.map((s) => s.state)).toEqual([
          "armed",
          "not-active",
        ]),
      );
      const result = await f.read();
      expect(result.configuredSources[1]?.startDiagnostic).toBe("id-conflict");
      expect(start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(await f.store.listSessionEntries()).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it("rejects a duplicate fixed ID after its first capture ends without changing saved notes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // Crossing midnight lets an accidental second capture create a distinct archive row.
    vi.setSystemTime(new Date("2026-09-05T23:59:58.000Z"));
    const entry = { ...room, sessionId: "daily" };
    const delayedId = "delayed-voice";
    const f = fixture({
      transcripts: { autoStart: [entry, { ...entry, providerId: delayedId }] },
    });
    const start = vi.fn(f.provider.start!);
    const delayedStart = vi.fn(f.provider.start!);
    f.provider.start = start;
    const delayedProvider = { ...f.provider, id: delayedId, start: delayedStart };
    vi.mocked(providerRegistry.getTranscriptSourceProvider).mockImplementation((id) =>
      id === room.providerId ? f.provider : undefined,
    );
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      service.start();
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources).toMatchObject([
          { state: "armed" },
          { startDiagnostic: "retrying" },
        ]),
      );
      const request = start.mock.calls[0]![0];
      await request.onUtterance({ text: "Saved before the duplicate retry", final: true });
      await request.onStatus!({ active: false });
      expect((await f.read()).active).toEqual([]);
      const session = (await f.store.readSession(entry.sessionId))!;
      expect(session.stoppedAt).toEqual(expect.any(String));
      const notes = await f.store.readSummary(session);
      expect(notes.summary?.transcript).toEqual(["Saved before the duplicate retry"]);
      const revision = f.store.readSummaryInputRevision(session);
      vi.mocked(providerRegistry.getTranscriptSourceProvider).mockImplementation((id) =>
        id === delayedId ? delayedProvider : f.provider,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(async () =>
        expect((await f.read()).configuredSources[1]?.startDiagnostic).not.toBe("starting"),
      );
      expect.soft((await f.read()).configuredSources[1]).toMatchObject({
        state: "not-active",
        startDiagnostic: "id-conflict",
        activeSelectors: [],
      });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(start).toHaveBeenCalledOnce();
      expect(delayedStart).not.toHaveBeenCalled();
      expect(await f.store.listSessionEntries()).toHaveLength(1);
      expect(await f.store.readSession(entry.sessionId)).toEqual(session);
      expect(await f.store.readSummary(session)).toEqual(notes);
      expect(f.store.readSummaryInputRevision(session)).toBe(revision);
    } finally {
      await service.stop();
    }
  });

  it("fences late diagnostics and teardown against a replacement service and a manual capture", async () => {
    const f = fixture({ transcripts: { autoStart: [{ ...room, sessionId: "pending" }] } });
    const gate = createDeferred();
    let pending: TranscriptStartRequest | undefined;
    f.provider.start = async (request) => {
      if (request.session.sessionId === "pending") {
        pending = request;
        await gate.promise;
      }
      return { ok: true, session: request.session };
    };
    const old = createTranscriptsAutoStartService(f.ctx);
    old.start();
    await vi.waitFor(() => expect(pending).toBeDefined());
    const stopping = old.stop();
    await f.start({ ...room, sessionId: "manual" });
    const config = { transcripts: { autoStart: [{ ...room, sessionId: "manual" }] } };
    const replacement = createTranscriptsAutoStartService({ ...f.ctx, config });
    try {
      replacement.start();
      await vi.waitFor(async () =>
        expect(
          (await readTranscriptLibraryStatus(f.store, config)).configuredSources[0]
            ?.startDiagnostic,
        ).toBe("id-conflict"),
      );
      gate.resolve();
      await stopping;
      await old.stop();
      expect(
        (await readTranscriptLibraryStatus(f.store, config)).configuredSources[0]?.startDiagnostic,
      ).toBe("id-conflict");
      await pending!.onUtterance({ text: "stale pending note" });
      await expect(f.store.readUtterancesForSession(pending!.session)).resolves.toEqual([]);
      expect((await f.read()).active.map((s) => s.sessionId)).toEqual(["manual"]);
      await replacement.stop();
      expect((await f.read()).active.map((s) => s.sessionId)).toEqual(["manual"]);
    } finally {
      gate.resolve();
      await stopping;
      await replacement.stop();
      await f.tool.execute("stop", { action: "stop", sessionId: "manual" });
    }
  });
  it.each(
    (["accountId", "guildId", "channelId", "meetingUrl"] as const).flatMap((key) =>
      ([undefined, true] as const).map((configuredLifecycle) => ({ key, configuredLifecycle })),
    ),
  )(
    "does not let an explicit $key capture arm an omitted locator (configured=$configuredLifecycle)",
    async ({ key, configuredLifecycle }) => {
      const source = {
        ...room,
        ...(key === "meetingUrl" ? { meetingUrl: "https://example.test/room" } : {}),
      };
      const configured = { ...source, [key]: undefined };
      const f = fixture({ transcripts: { autoStart: [configured] } });
      const sessionId = configuredLifecycle ? "configured" : "manual";
      await f.start({ ...source, sessionId }, configuredLifecycle);
      const result = await f.read();
      expect(result.configuredSources[0]).toMatchObject({
        state: configuredLifecycle ? "not-active" : "unknown",
        activeSelectors: [],
      });
      expect(result.active).toMatchObject([{ sessionId, activeSubscription: true }]);
      await f.tool.execute("stop", { action: "stop", sessionId });
    },
  );

  it("associates a successful configured default start with its requested source, not its resolved account", async () => {
    const configured = { ...room, providerId: " voice-alias ", accountId: undefined };
    const config = {
      transcripts: {
        autoStart: [configured],
      },
    };
    const f = fixture(config);
    const service = createTranscriptsAutoStartService(f.ctx);
    service.start();
    try {
      await vi.waitFor(async () => expect((await f.read()).active).toHaveLength(1));
      const result = await f.read();
      const capture = result.active[0]!;
      expect(capture.source).toMatchObject({ accountId: "default", providerId: "voice-alias" });
      expect(result.configuredSources[0]).toMatchObject({
        state: "armed",
        activeSelectors: [capture.selector],
      });
      const explicit = await readTranscriptLibraryStatus(f.store, {
        transcripts: { autoStart: [{ ...room, accountId: "default" }] },
      });
      expect(explicit.configuredSources[0]).toMatchObject({
        state: "not-active",
        activeSelectors: [],
      });
      // Provider-only registrations need not remain in the active registry for alias evidence.
      setActivePluginRegistry(createEmptyPluginRegistry());
      expect((await f.read()).configuredSources[0]?.state).toBe("armed");
      expect(JSON.stringify(await f.store.readSession(capture.sessionId))).not.toContain(
        "configuredSource",
      );
      expect(JSON.stringify(result)).not.toContain('"configuredSource":');
      expect(JSON.stringify(await f.tool.execute("status", { action: "status" }))).not.toContain(
        "configuredSource",
      );
    } finally {
      await service.stop();
    }
    expect((await f.read()).active).toEqual([]);
  });

  it("requires complete manual identity and preserves exact explicit matching", async () => {
    const f = fixture();
    for (const configuredLifecycle of [undefined, true] as const) {
      const sessionId = configuredLifecycle ? "configured-exact" : "manual-exact";
      await f.start({ ...room, sessionId }, configuredLifecycle);
      const exact = await f.read();
      expect(exact.configuredSources[0]).toMatchObject({
        state: "armed",
        activeSelectors: [exact.active[0]!.selector],
      });
      for (const key of ["accountId", "guildId", "channelId"] as const) {
        const other = await readTranscriptLibraryStatus(f.store, {
          transcripts: { autoStart: [{ ...room, [key]: "other" }] },
        });
        expect(other.configuredSources[0]).toMatchObject({
          state: "not-active",
          activeSelectors: [],
        });
      }
      await f.tool.execute("stop", { action: "stop", sessionId });
    }
    await f.start({
      ...room,
      accountId: undefined,
      guildId: undefined,
      sessionId: "manual-default",
    });
    const result = await readTranscriptLibraryStatus(f.store, {
      transcripts: { autoStart: [{ ...room, accountId: undefined }] },
    });
    expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
  });

  it("retains only configured URL presence and never claims exact invitation identity", async () => {
    const url = new URL("https://example.test/room?invitation=synthetic-invite#synthetic-fragment");
    url.username = "synthetic-user";
    url.password = "synthetic-password";
    const source = { ...room, meetingUrl: url.href };
    const f = fixture({
      transcripts: { autoStart: [source, { ...source, meetingUrl: "https://example.test/room" }] },
    });
    await f.start({ ...source, sessionId: "url", privateMarker: "not-source-intent" }, true);
    const result = await f.read();
    expect(
      result.configuredSources.map(({ state, activeSelectors }) => ({ state, activeSelectors })),
    ).toEqual([
      { state: "unknown", activeSelectors: [] },
      { state: "unknown", activeSelectors: [] },
    ]);
    expect(result.active[0]?.activeSubscription).toBe(true);
    const snapshot = readTranscriptCaptureSnapshot();
    expect(snapshot[0]).toHaveProperty("configuredSource.meetingUrl", true);
    const retained = JSON.stringify([snapshot, await f.store.readSession("url"), result]);
    for (const privateText of ["synthetic-", "privateMarker", "not-source-intent"]) {
      expect(retained).not.toContain(privateText);
    }
  });

  it("keeps configured cleanup and in-flight stop owners unknown without transferring their evidence", async () => {
    const source = { ...room, accountId: undefined };
    const f = fixture({ transcripts: { autoStart: [source] } });
    const controller = new AbortController();
    f.provider.start = async ({ session }) => {
      controller.abort();
      return { ok: true, session };
    };
    f.provider.stop = async () => ({ ok: false, error: "cleanup pending" });
    await expect(
      startTranscripts({
        ctx: f.ctx,
        store: f.store,
        rawParams: { ...source, sessionId: "retained" },
        configuredLifecycle: true,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("provider cleanup failed");
    const retainedSession = await f.store.readSession("retained");
    expect(readTranscriptCaptureSnapshot()[0]).toHaveProperty(
      "configuredSource.accountId",
      undefined,
    );
    expect((await f.read()).configuredSources[0]).toMatchObject({
      state: "unknown",
      activeSelectors: [],
    });
    const stopGate = createDeferred();
    const stopping = createDeferred();
    f.provider.stop = async ({ sessionId }) => {
      stopping.resolve();
      await stopGate.promise;
      return { ok: true, sessionId };
    };
    const stopped = f.tool.execute("stop", { action: "stop", sessionId: "retained" });
    await stopping.promise;
    try {
      const result = await f.read();
      expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
      expect(result.active[0]?.activeSubscription).toBe(false);
    } finally {
      stopGate.resolve();
      await stopped;
    }
    f.provider.start = async ({ session }) => ({ ok: true, session });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(retainedSession!.startedAt) + 86_400_000));
    await f.start({ ...room, sessionId: "retained" });
    expect((await f.read()).configuredSources[0]).toMatchObject({
      state: "unknown",
      activeSelectors: [],
    });
  });
});
