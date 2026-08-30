import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRoomEventSource,
  createAdmittedUserRequestSource,
} from "../../../test/helpers/admitted-room-event-source.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  copyChannelParticipantAdmissionEvidence,
  readCurrentHostChannelContextOwner,
} from "../../channels/message-access/admission-evidence.js";
import { bindSourceFinalizationPrivateOptions } from "./source-finalization-private-state.js";
import {
  bindAdmittedMatrixSourceFinalizationRequest,
  readSourceFinalizationPrivateOptions,
} from "./source-finalization-private.js";
import type { SourceFinalizationPrivateOptions } from "./source-finalization.types.js";

const MATRIX_SOURCE_FINALIZATION_REQUEST = Symbol.for(
  "openclaw.matrixSourceFinalizationRequest.v1",
);

function requestSourceFinalization<T extends object>(
  replyOptions: T,
  request: {
    sourceContext: object;
    onBeforeAgentFinalize?: SourceFinalizationPrivateOptions["onBeforeAgentFinalize"];
  },
): T {
  const requested = { ...replyOptions };
  Object.defineProperty(requested, MATRIX_SOURCE_FINALIZATION_REQUEST, {
    enumerable: true,
    value: Object.freeze(request),
  });
  return requested;
}

describe("source finalization private carrier", () => {
  it("survives enumerable object spreads without exposing public string keys", () => {
    const gate = vi.fn(async () => ({ action: "continue" as const }));
    const bound = bindSourceFinalizationPrivateOptions(
      { sourceReplyDeliveryMode: "automatic" as const },
      {
        onBeforeAgentFinalize: gate,
        deferSourceMessageToolDelivery: true,
        retainQueuedSourceReplyDelivery: true,
      },
    );
    const spreadTwice = { ...bound, disableBlockStreaming: true };

    expect(readSourceFinalizationPrivateOptions(spreadTwice)).toEqual({
      onBeforeAgentFinalize: gate,
      deferSourceMessageToolDelivery: true,
      retainQueuedSourceReplyDelivery: true,
    });
    expect(Object.keys(spreadTwice)).not.toEqual(
      expect.arrayContaining([
        "onBeforeAgentFinalize",
        "deferSourceMessageToolDelivery",
        "retainQueuedSourceReplyDelivery",
      ]),
    );
  });

  it("rejects fabricated carrier tokens", () => {
    const fabricated = {
      [Symbol.for("openclaw.sourceFinalizationPrivateCarrier")]: {},
    };
    expect(readSourceFinalizationPrivateOptions(fabricated)).toBeUndefined();
    expect(readSourceFinalizationPrivateOptions({})).toBeUndefined();
  });

  it("redeems a request only for its exact admitted live source", async () => {
    const source = await createAdmittedRoomEventSource({ channelId: "matrix" });
    try {
      const gate = vi.fn(async () => ({ action: "continue" as const }));
      const requested = requestSourceFinalization(
        { sourceReplyDeliveryMode: "automatic" as const },
        {
          sourceContext: source.context,
          onBeforeAgentFinalize: gate,
        },
      );

      const bound = bindAdmittedMatrixSourceFinalizationRequest({
        replyOptions: requested,
        context: source.context,
        capability: source.capability,
      });

      expect(readSourceFinalizationPrivateOptions(bound)).toMatchObject({
        onBeforeAgentFinalize: expect.any(Function),
        isSourceLive: expect.any(Function),
        deferSourceMessageToolDelivery: true,
        retainQueuedSourceReplyDelivery: true,
      });
      expect(Object.hasOwn(bound, MATRIX_SOURCE_FINALIZATION_REQUEST)).toBe(false);
    } finally {
      source.retire();
    }
  });

  it("redeems a host-owned user request without room-event delivery authority", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    try {
      const gate = vi.fn(async () => ({ action: "continue" as const }));
      const bound = bindAdmittedMatrixSourceFinalizationRequest({
        replyOptions: requestSourceFinalization(
          { sourceReplyDeliveryMode: "automatic" as const },
          { sourceContext: source.context, onBeforeAgentFinalize: gate },
        ),
        context: source.context,
      });

      const privateOptions = readSourceFinalizationPrivateOptions(bound);
      expect(privateOptions).toMatchObject({
        onBeforeAgentFinalize: expect.any(Function),
        isSourceLive: expect.any(Function),
        deferSourceMessageToolDelivery: true,
        retainQueuedSourceReplyDelivery: true,
      });
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: requestSourceFinalization(
            { sourceReplyDeliveryMode: "automatic" as const },
            { sourceContext: source.context, onBeforeAgentFinalize: gate },
          ),
          context: { ...source.context },
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
      await expect(
        privateOptions?.onBeforeAgentFinalize?.({
          runId: "live-run",
          sessionId: "live-session",
          provider: "openai",
          model: "gpt-test",
          lastAssistantMessage: "live",
          revisionAttempt: 0,
        }),
      ).resolves.toEqual({ action: "continue" });
      source.retire();
      await expect(
        privateOptions?.onBeforeAgentFinalize?.({
          runId: "retired-run",
          sessionId: "retired-session",
          provider: "openai",
          model: "gpt-test",
          lastAssistantMessage: "retired",
          revisionAttempt: 0,
        }),
      ).resolves.toEqual({ action: "discard" });
      expect(gate).toHaveBeenCalledOnce();
    } finally {
      source.retire();
    }
  });

  it("rejects a global Matrix owner before installing the private finalizer", async () => {
    const source = await createAdmittedUserRequestSource({
      channelId: "matrix",
      ownerRecord: Object.freeze({ id: "matrix", origin: "global", status: "loaded" }),
    });
    const gate = vi.fn(async () => ({ action: "continue" as const }));
    try {
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: requestSourceFinalization(
            { sourceReplyDeliveryMode: "automatic" as const },
            { sourceContext: source.context, onBeforeAgentFinalize: gate },
          ),
          context: source.context,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
      expect(gate).not.toHaveBeenCalled();
    } finally {
      source.retire();
    }
  });

  it.each(["slack", "telegram", "discord"])(
    "rejects an exact live host-owned %s request",
    async (channelId) => {
      const source = await createAdmittedUserRequestSource({ channelId });
      const gate = vi.fn(async () => ({ action: "continue" as const }));
      try {
        expect(() =>
          bindAdmittedMatrixSourceFinalizationRequest({
            replyOptions: requestSourceFinalization(
              { sourceReplyDeliveryMode: "automatic" as const },
              { sourceContext: source.context, onBeforeAgentFinalize: gate },
            ),
            context: source.context,
          }),
        ).toThrow("Source-final freshness requires automatic delivery");
        expect(gate).not.toHaveBeenCalled();
      } finally {
        source.retire();
      }
    },
  );

  it("rejects a request replayed onto another context with the same live Matrix owner", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const otherContext = { ...source.context };
    copyChannelParticipantAdmissionEvidence(source.context, otherContext);
    try {
      expect(readCurrentHostChannelContextOwner(source.context)).toBeDefined();
      expect(readCurrentHostChannelContextOwner(otherContext)).toBe(
        readCurrentHostChannelContextOwner(source.context),
      );
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: requestSourceFinalization(
            { sourceReplyDeliveryMode: "automatic" as const },
            { sourceContext: source.context },
          ),
          context: otherContext,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
    } finally {
      source.retire();
    }
  });

  it("discards a freshness decision when the Matrix owner retires while it is pending", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const gateStarted = createDeferred();
    const releaseGate = createDeferred();
    const gate = vi.fn(async () => {
      gateStarted.resolve();
      await releaseGate.promise;
      return {
        action: "revise" as const,
        instruction: "stale revision",
        disableTools: true as const,
      };
    });
    try {
      const bound = bindAdmittedMatrixSourceFinalizationRequest({
        replyOptions: requestSourceFinalization(
          { sourceReplyDeliveryMode: "automatic" as const },
          { sourceContext: source.context, onBeforeAgentFinalize: gate },
        ),
        context: source.context,
      });
      const decision = readSourceFinalizationPrivateOptions(bound)!.onBeforeAgentFinalize!({
        runId: "run-pending",
        sessionId: "session-pending",
        provider: "openai",
        model: "gpt-test",
        lastAssistantMessage: "candidate",
        revisionAttempt: 0,
      });
      await gateStarted.promise;
      source.retire();
      releaseGate.resolve();

      await expect(decision).resolves.toEqual({ action: "discard" });
    } finally {
      releaseGate.resolve();
      source.retire();
    }
  });

  it("suppresses source cleanup when its Matrix owner retires before acceptance", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const onAccepted = vi.fn();
    try {
      const bound = bindAdmittedMatrixSourceFinalizationRequest({
        replyOptions: requestSourceFinalization(
          { sourceReplyDeliveryMode: "automatic" as const },
          {
            sourceContext: source.context,
            onBeforeAgentFinalize: async () => ({
              action: "discard" as const,
              onAccepted,
            }),
          },
        ),
        context: source.context,
      });
      const decision = await readSourceFinalizationPrivateOptions(bound)!.onBeforeAgentFinalize!({
        runId: "run-accepted",
        sessionId: "session-accepted",
        provider: "openai",
        model: "gpt-test",
        lastAssistantMessage: "candidate",
        revisionAttempt: 0,
      });
      expect(decision.action).toBe("discard");
      source.retire();
      if (decision.action === "discard") {
        await decision.onAccepted?.();
      }
      expect(onAccepted).not.toHaveBeenCalled();
    } finally {
      source.retire();
    }
  });

  it("passes accepted cleanup the exact Matrix owner lifecycle capability", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const onAccepted = vi.fn(async (...args: unknown[]) => {
      const capability = args[0] as { isSourceLive?: () => boolean } | undefined;
      expect(capability?.isSourceLive?.()).toBe(true);
      source.retire();
      expect(capability?.isSourceLive?.()).toBe(false);
    });
    try {
      const bound = bindAdmittedMatrixSourceFinalizationRequest({
        replyOptions: requestSourceFinalization(
          { sourceReplyDeliveryMode: "automatic" as const },
          {
            sourceContext: source.context,
            onBeforeAgentFinalize: async () => ({ action: "discard" as const, onAccepted }),
          },
        ),
        context: source.context,
      });
      const decision = await readSourceFinalizationPrivateOptions(bound)!.onBeforeAgentFinalize!({
        runId: "run-cleanup-capability",
        sessionId: "session-cleanup-capability",
        provider: "openai",
        model: "gpt-test",
        lastAssistantMessage: "candidate",
        revisionAttempt: 0,
      });

      expect(decision.action).toBe("discard");
      if (decision.action === "discard") {
        await decision.onAccepted?.();
      }
      expect(onAccepted).toHaveBeenCalledOnce();
    } finally {
      source.retire();
    }
  });

  it("rejects missing, forged, mismatched, and retired source requests without authority", async () => {
    const source = await createAdmittedRoomEventSource({ channelId: "matrix" });
    const request = () =>
      requestSourceFinalization(
        { sourceReplyDeliveryMode: "automatic" as const },
        { sourceContext: source.context },
      );
    try {
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: request(),
          context: source.context,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: request(),
          context: source.context,
          capability: {} as typeof source.capability,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: requestSourceFinalization(
            { sourceReplyDeliveryMode: "automatic" as const },
            { sourceContext: {} },
          ),
          context: source.context,
          capability: source.capability,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");

      source.retire();
      expect(() =>
        bindAdmittedMatrixSourceFinalizationRequest({
          replyOptions: request(),
          context: source.context,
          capability: source.capability,
        }),
      ).toThrow("Source-final freshness requires automatic delivery");
    } finally {
      source.retire();
    }
  });

  it("strips an accessor-shaped request without invoking it", () => {
    const getter = vi.fn();
    const requested = { sourceReplyDeliveryMode: "automatic" as const };
    Object.defineProperty(requested, MATRIX_SOURCE_FINALIZATION_REQUEST, {
      enumerable: true,
      get: getter,
    });

    const stripped = bindAdmittedMatrixSourceFinalizationRequest({
      replyOptions: requested,
      context: {},
    });

    expect(getter).not.toHaveBeenCalled();
    expect(Object.hasOwn(stripped, MATRIX_SOURCE_FINALIZATION_REQUEST)).toBe(false);
  });
});
