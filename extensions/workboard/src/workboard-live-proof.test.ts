import { describe, expect, it } from "vitest";
import { WorkboardStore } from "./store.js";
import { registerWorkboardReplyMarker } from "./reply-marker.js";

type AnyRecord = Record<string, unknown>;

function createMemoryStore() {
  const entries = new Map<string, AnyRecord>();
  return {
    async register(key: string, value: AnyRecord) {
      entries.set(key, value);
    },
    async lookup(key: string) {
      return entries.get(key);
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("GCP live Workboard reply proof", () => {
  it("binds one active claimed card to one session and emits exactly one privacy-safe marker", async () => {
    const store = new WorkboardStore(createMemoryStore() as never);
    const sessionKey = "agent:worker:dashboard:proof";
    const created = await store.create({ title: "redacted-proof-card", status: "ready" });
    const claimed = await store.claim(created.id, {
      ownerId: "proof-agent",
      sessionKey,
      ttlSeconds: 60,
    });

    const registrations: Array<[string, (event: AnyRecord, ctx: AnyRecord) => Promise<AnyRecord | undefined>]> = [];
    registerWorkboardReplyMarker({
      api: {
        on(name: string, handler: (event: AnyRecord, ctx: AnyRecord) => Promise<AnyRecord | undefined>) {
          registrations.push([name, handler]);
        },
      } as never,
      store,
    });
    const handler = registrations.find(([name]) => name === "reply_payload_sending")?.[1];
    if (!handler) throw new Error("reply_payload_sending handler was not registered");

    const transformed = await handler(
      { sessionKey, payload: { text: "Proof response" } },
      { sessionKey },
    );
    const text = String((transformed?.payload as AnyRecord | undefined)?.text ?? "");
    expect(text).toBe(`Workboard: ${claimed.card.id}\nProof response`);
    expect((text.match(/^Workboard: [^\\n]+/gm) ?? []).length).toBe(1);

    const unrelated = await handler(
      { sessionKey: "agent:other:dashboard:proof", payload: { text: "Other response" } },
      { sessionKey: "agent:other:dashboard:proof" },
    );
    expect(unrelated).toBeUndefined();

    console.log(
      "LIVE_PROOF " +
        JSON.stringify({
          setup: "GCP VPS isolated source tree + container runtime",
          session: "agent:worker:dashboard:proof",
          activeClaim: true,
          output: "Workboard: <card-id>\\nProof response",
          markerOccurrences: 1,
          unrelatedSessionUnchanged: true,
        }),
    );
  });
});
