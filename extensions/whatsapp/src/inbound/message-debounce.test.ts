import { describe, expect, it, vi } from "vitest";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import type { WhatsAppQueuedInboundMessage } from "./message-debounce.js";
import type { WebInboundMessageInput } from "./types.js";

const CONVERSATION = "999@s.whatsapp.net";

const CONTACT_CONTEXT = [
  {
    label: "WhatsApp contact",
    source: "whatsapp",
    type: "contact",
    payload: {
      kind: "contact",
      total: 1,
      contacts: [{ name: "Ada Lovelace", phones: ["+15555550123"] }],
    },
  },
];

function queuedMessage(
  body: string,
  channelStructuredContext?: unknown[],
): WhatsAppQueuedInboundMessage {
  return {
    admission: {
      accountId: "work",
      conversation: { kind: "direct", id: CONVERSATION },
      sender: { id: CONVERSATION },
    },
    platform: {
      sender: CONVERSATION,
      senderJid: CONVERSATION,
      senderE164: "+15550001111",
      senderName: "Tester",
      chatJid: CONVERSATION,
    },
    payload: {
      body,
      ...(channelStructuredContext ? { channelStructuredContext } : {}),
    },
    event: {},
  } as unknown as WhatsAppQueuedInboundMessage;
}

/**
 * These drive `createWhatsAppInboundMessageDebouncer` directly rather than the
 * whole inbox chain, and that is deliberate.
 *
 * The durable ingress queue serialises by lane (`laneKey = remoteJid`) and holds
 * the lane while a claim is deferred — `deferredLaneOccupancy` defaults to
 * `"hold"` in `src/channels/message/ingress-drain.ts`, and the WhatsApp monitor
 * does not override it. So two messages from one conversation reach the
 * debouncer one flush apart and a batch never forms end to end today; the
 * pre-existing test `keeps same-lane follow-up pending until turn adoption`
 * documents that behaviour as intended.
 *
 * Driving the full chain would therefore assert something the product cannot do,
 * which is how the first version of this test came to fail. The batching branch
 * is still wrong on its own terms, and it is what these cover.
 */
describe("whatsapp inbound debouncer batching", () => {
  async function flushBatch(entries: WhatsAppQueuedInboundMessage[]) {
    const delivered: WebInboundMessageInput[] = [];
    vi.useFakeTimers();
    try {
      const debouncer = createWhatsAppInboundMessageDebouncer({
        debounceMs: 50,
        onMessage: async (msg) => {
          delivered.push(msg);
        },
        markRead: async () => undefined,
        onPendingWorkChanged: () => undefined,
        onError: (error) => {
          throw error;
        },
      });
      for (const entry of entries) {
        await debouncer.enqueue(entry);
      }
      await vi.advanceTimersByTimeAsync(200);
      await debouncer.drain();
    } finally {
      vi.useRealTimers();
    }
    return delivered;
  }

  // The regression. A contact card followed by a text used to lose the contact
  // entirely: the batch kept only `last.payload`, and the earlier entry's
  // channelStructuredContext went with it. The model then answered "call her"
  // with no idea who "her" was or what number to use.
  it("keeps the structured context of an earlier entry in the batch", async () => {
    const delivered = await flushBatch([
      queuedMessage("<contact>", CONTACT_CONTEXT),
      queuedMessage("Please call her"),
    ]);

    expect(delivered).toHaveLength(1);
    const batch = delivered[0]!;
    expect(batch.payload?.body).toBe("<contact>\nPlease call her");
    expect(batch.event?.isBatched).toBe(true);
    expect(batch.payload?.channelStructuredContext).toEqual(CONTACT_CONTEXT);
  });

  // Order matters for the model reading it, so the batch has to concatenate
  // rather than pick one entry.
  it("concatenates the structured context of several entries in receive order", async () => {
    const second = [
      { ...CONTACT_CONTEXT[0], payload: { kind: "contact", total: 1, contacts: [] } },
    ];
    const delivered = await flushBatch([
      queuedMessage("<contact>", CONTACT_CONTEXT),
      queuedMessage("<contact>", second),
      queuedMessage("and this one too"),
    ]);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload?.channelStructuredContext).toEqual([
      ...CONTACT_CONTEXT,
      ...second,
    ]);
  });

  // Negative case: a text-only batch must not grow an empty array where the
  // field used to be absent, because downstream code distinguishes the two.
  it("leaves the field absent when no entry carried structured context", async () => {
    const delivered = await flushBatch([queuedMessage("first line"), queuedMessage("second line")]);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload?.body).toBe("first line\nsecond line");
    expect(delivered[0]!.payload?.channelStructuredContext).toBeUndefined();
  });
});
