import path from "node:path";
import {
  runChannelInboundEvent,
  type ChannelInboundEventRunnerParams,
} from "openclaw/plugin-sdk/channel-inbound";
import type { FinalizedMsgContext, GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

type MatrixInboundRun = MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"];
type MatrixInboundRunParams = Parameters<MatrixInboundRun>[0];
type TurnAdoptionLifecycle = NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createClaimSpies() {
  return {
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

function releaseSyntheticResolverAdmissionTicket(options: GetReplyOptions | undefined): void {
  if (!options) {
    throw new Error("expected reply options with an admission ticket");
  }
  const symbolOptions = options as GetReplyOptions & Record<symbol, unknown>;
  const tickets = Object.getOwnPropertySymbols(options)
    .map((key) => symbolOptions[key])
    .filter(
      (value): value is { wait: (signal?: AbortSignal) => Promise<boolean>; release: () => void } =>
        typeof value === "object" &&
        value !== null &&
        "wait" in value &&
        typeof value.wait === "function" &&
        "release" in value &&
        typeof value.release === "function",
    );
  const ticket = tickets.at(0);
  if (tickets.length !== 1 || !ticket) {
    throw new Error(`expected one reply admission ticket, received ${tickets.length}`);
  }
  // A real getReplyFromConfig run releases this ticket when runReplyAgent publishes
  // queue/run ownership. The synthetic resolver must model the same handoff.
  ticket.release();
}

describe("Matrix active-turn steering admission", () => {
  it.each([
    {
      name: "configured steer mode",
      followupBody: "use the monochrome version instead",
      explicitSteer: false,
    },
    {
      name: "an explicit /steer command",
      followupBody: "/steer use the monochrome version instead",
      explicitSteer: true,
    },
  ])(
    "lets $name reach queue policy while the prior Matrix turn is active",
    async ({ followupBody, explicitSteer }) => {
      installMatrixMonitorTestRuntime();
      const tempDir = tempDirs.make("openclaw-matrix-steer-");
      const storePath = path.join(tempDir, "sessions.json");
      const activeEventId = explicitSteer ? "$active-explicit-steer" : "$active-configured-steer";
      const followupEventId = explicitSteer ? "$explicit-steer" : "$configured-steer";
      const activeResolverStarted = createDeferred();
      const releaseActiveResolver = createDeferred();
      const followupTurnResolved = createDeferred();
      const claimsByEvent = new Map<string, ReturnType<typeof createClaimSpies>>();
      const inboundLifecycles = new Map<string, TurnAdoptionLifecycle | undefined>();
      let followupResolverLifecycle: TurnAdoptionLifecycle | undefined;
      let followupResolverContext: FinalizedMsgContext | undefined;

      const cfg = {
        session: { store: storePath },
        messages: { queue: { mode: "steer" } },
        channels: { matrix: { dm: { allowFrom: ["*"] } } },
      } satisfies OpenClawConfig;
      const inboundDeduper: NonNullable<MatrixMonitorHandlerParams["inboundDeduper"]> = {
        claim: vi.fn(async ({ eventId }) => {
          const claim = createClaimSpies();
          claimsByEvent.set(eventId, claim);
          return {
            kind: "claimed" as const,
            handle: {
              keys: [eventId] as const,
              commit: claim.commit,
              release: claim.release,
            },
          };
        }),
      };
      const queuePolicyResolver = vi.fn(
        async (ctx: FinalizedMsgContext, options?: GetReplyOptions) => {
          releaseSyntheticResolverAdmissionTicket(options);
          const eventId = ctx.MessageSid;
          if (eventId === activeEventId) {
            await options?.turnAdoptionLifecycle?.onAdopted();
            activeResolverStarted.resolve();
            await releaseActiveResolver.promise;
            return undefined;
          }
          if (eventId === followupEventId) {
            followupResolverContext = ctx;
            followupResolverLifecycle = options?.turnAdoptionLifecycle;
            if (!followupResolverLifecycle?.onDeferred) {
              throw new Error("expected Matrix follow-up deferral ownership");
            }
            expect(followupResolverLifecycle.onDeferred()).not.toBe(false);
            await followupResolverLifecycle.onAdopted();
          }
          return undefined;
        },
      );
      const runWithQueuePolicyResolver = (async (params: MatrixInboundRunParams) => {
        const eventId = (params.raw as MatrixRawEvent).event_id;
        if (eventId) {
          inboundLifecycles.set(eventId, params.turnAdoptionLifecycle);
        }
        const adapter = params.adapter;
        return await runChannelInboundEvent({
          ...params,
          adapter: {
            ...adapter,
            resolveTurn: async (...args: Parameters<typeof adapter.resolveTurn>) => {
              const turn = await adapter.resolveTurn(...args);
              if (eventId === followupEventId) {
                followupTurnResolved.resolve();
              }
              if (!("route" in turn) || "runDispatch" in turn) {
                throw new Error("expected Matrix to resolve a routed channel turn");
              }
              return { ...turn, replyResolver: queuePolicyResolver as never };
            },
          },
        } as ChannelInboundEventRunnerParams<MatrixRawEvent>);
      }) as MatrixInboundRun;
      const runtime = { error: vi.fn() };
      const { handler } = createMatrixHandlerTestHarness({
        cfg,
        inboundDeduper,
        runtime: runtime as never,
        shouldHandleTextCommands: () => true,
        hasControlCommand: (text?: string) => text?.startsWith("/steer") === true,
        runChannelInboundEvent: runWithQueuePolicyResolver,
      });

      let activeTurn: Promise<void> | undefined;
      let followupTurn: Promise<void> | undefined;
      try {
        activeTurn = handler(
          "!room:example.org",
          createMatrixTextMessageEvent({
            eventId: activeEventId,
            body: "keep this run active",
          }),
        );
        await vi.waitFor(() => expect(queuePolicyResolver).toHaveBeenCalledTimes(1), {
          // This suite imports the full Matrix extension graph. Keep the
          // active-turn admission assertion deterministic on saturated CI
          // workers without weakening the behavior being asserted.
          timeout: 10_000,
          interval: 10,
        });
        await activeResolverStarted.promise;

        followupTurn = handler(
          "!room:example.org",
          createMatrixTextMessageEvent({
            eventId: followupEventId,
            body: followupBody,
          }),
        );
        await followupTurnResolved.promise;

        // Before the fix, the second Matrix turn waits at reply-operation admission here;
        // queue policy cannot see either configured steer mode or the explicit command.
        await vi.waitFor(() => expect(queuePolicyResolver).toHaveBeenCalledTimes(2), {
          timeout: 500,
          interval: 10,
        });

        expect(followupResolverContext?.CommandBody).toBe(followupBody);
        expect(inboundLifecycles.get(followupEventId)).toMatchObject({ admission: "exclusive" });
        // Core wraps the lifecycle to record adoption state; invoking that wrapper must still
        // settle the exact replay claim captured by the Matrix handler above.
        expect(followupResolverLifecycle).toMatchObject({ admission: "exclusive" });
        expect(claimsByEvent.get(followupEventId)?.commit).toHaveBeenCalledOnce();
        expect(claimsByEvent.get(followupEventId)?.release).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
      } finally {
        releaseActiveResolver.resolve();
        const turns = [activeTurn, followupTurn].filter(
          (turn): turn is Promise<void> => turn !== undefined,
        );
        await Promise.allSettled(turns);
      }
    },
  );

  it.each([
    {
      name: "adoption commits it",
      eventId: "$adopted-followup",
      settlement: "onAdopted" as const,
      expectedCommits: 1,
      expectedReleases: 0,
    },
    {
      name: "abandonment releases it",
      eventId: "$abandoned-followup",
      settlement: "onAbandoned" as const,
      expectedCommits: 0,
      expectedReleases: 1,
    },
  ])(
    "keeps a deferred replay claim past handler return until $name",
    async ({ eventId, settlement, expectedCommits, expectedReleases }) => {
      installMatrixMonitorTestRuntime();
      const claim = createClaimSpies();
      let deferredLifecycle: TurnAdoptionLifecycle | undefined;
      const inboundDeduper: NonNullable<MatrixMonitorHandlerParams["inboundDeduper"]> = {
        claim: vi.fn(async () => ({
          kind: "claimed" as const,
          handle: {
            keys: [eventId] as const,
            commit: claim.commit,
            release: claim.release,
          },
        })),
      };
      const runWithDeferredOwnership = (async (params: MatrixInboundRunParams) => {
        deferredLifecycle = params.turnAdoptionLifecycle;
        expect(deferredLifecycle?.onDeferred?.()).not.toBe(false);
        return {
          admission: { kind: "dispatch" as const },
          dispatched: true as const,
          ctxPayload: {} as FinalizedMsgContext,
          routeSessionKey: "agent:ops:main",
          dispatchResult: {
            queuedFinal: false,
            counts: { final: 0, block: 0, tool: 0 },
          },
        };
      }) as MatrixInboundRun;
      const { handler } = createMatrixHandlerTestHarness({
        inboundDeduper,
        runChannelInboundEvent: runWithDeferredOwnership,
      });

      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId, body: "wait for the active turn" }),
      );

      expect(deferredLifecycle).toMatchObject({ admission: "exclusive" });
      expect(claim.commit).not.toHaveBeenCalled();
      expect(claim.release).not.toHaveBeenCalled();

      await deferredLifecycle?.[settlement]?.();

      expect(claim.commit).toHaveBeenCalledTimes(expectedCommits);
      expect(claim.release).toHaveBeenCalledTimes(expectedReleases);
    },
  );
});
