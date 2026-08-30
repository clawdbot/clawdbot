import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRoomEventSource } from "../../../test/helpers/admitted-room-event-source.js";
import {
  copyChannelParticipantAdmissionEvidence,
  readCurrentHostChannelContextOwner,
} from "../../channels/message-access/admission-evidence.js";
import {
  bindQueuedSourceReplyDeliveryCapability,
  hasAutomaticRoomEventFinalCapability,
  hasQueuedSourceReplyDeliveryCapability,
} from "./automatic-room-event-final-capability.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

const cleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
});

describe("automatic room-event final capability", () => {
  it("authorizes only the exact live context admitted by the host", async () => {
    const source = await createAdmittedRoomEventSource();
    cleanups.add(source.retire);

    expect(
      hasAutomaticRoomEventFinalCapability({
        capability: source.capability,
        context: source.context,
      }),
    ).toBe(true);
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: {},
        ctx: source.context,
        requested: "automatic",
        automaticRoomEventFinalCapability: source.capability,
      }),
    ).toBe("automatic");

    const copiedContext = { ...source.context };
    expect(
      hasAutomaticRoomEventFinalCapability({
        capability: source.capability,
        context: copiedContext,
      }),
    ).toBe(false);
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: {},
        ctx: copiedContext,
        requested: "automatic",
        automaticRoomEventFinalCapability: source.capability,
      }),
    ).toBe("message_tool_only");
  });

  it("binds queued authority by identity and expires it with the host owner", async () => {
    const source = await createAdmittedRoomEventSource();
    cleanups.add(source.retire);
    const queued = source.createQueuedSourceReplyDelivery({
      deliver: vi.fn(async () => "delivered" as const),
    });

    expect(hasQueuedSourceReplyDeliveryCapability(queued)).toBe(true);
    expect(hasQueuedSourceReplyDeliveryCapability({ ...queued })).toBe(false);

    source.retire();
    cleanups.delete(source.retire);
    expect(hasQueuedSourceReplyDeliveryCapability(queued)).toBe(false);
  });

  it("does not bind one context's capability to another queued dispatcher", async () => {
    const source = await createAdmittedRoomEventSource();
    const other = await createAdmittedRoomEventSource();
    cleanups.add(source.retire);
    cleanups.add(other.retire);
    const queued = {
      deliver: vi.fn(async () => "delivered" as const),
      presentationOptions: {},
    };

    bindQueuedSourceReplyDeliveryCapability({
      queued,
      capability: source.capability,
      context: other.context,
    });

    expect(hasQueuedSourceReplyDeliveryCapability(queued)).toBe(false);
  });

  it("does not copy a host owner from a source whose admitted scope changed", async () => {
    const source = await createAdmittedRoomEventSource();
    cleanups.add(source.retire);
    const target = { ...source.context };
    (source.context as { MessageSid?: string }).MessageSid = "mutated-message";

    copyChannelParticipantAdmissionEvidence(source.context, target);

    expect(readCurrentHostChannelContextOwner(target)).toBeUndefined();
  });
});
