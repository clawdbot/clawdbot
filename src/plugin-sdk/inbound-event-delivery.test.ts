import { describe, expect, it } from "vitest";
import { createInboundEventDeliveryCorrelation } from "./inbound-event-delivery.js";

describe("inbound event delivery correlation", () => {
  it("retains mismatches and retires before invoking the delivery marker", () => {
    const correlation = createInboundEventDeliveryCorrelation({
      targetsMatch: (expected, actual) => expected === actual,
    });
    let markerCalls = 0;
    const end = correlation.begin(" session ", {
      outboundTo: "target",
      outboundAccountId: "account-a",
      markInboundEventDelivered: () => {
        markerCalls += 1;
        correlation.notify({ sessionKey: "session", to: "target" });
        throw new Error("marker failed");
      },
    });

    correlation.notify({ sessionKey: "session", to: "other" });
    correlation.notify({ sessionKey: "session", to: "target", accountId: "account-b" });
    expect(markerCalls).toBe(0);

    expect(() => correlation.notify({ sessionKey: "session", to: "target" })).toThrow(
      "marker failed",
    );
    expect(() => correlation.notify({ sessionKey: "session", to: "target" })).not.toThrow();
    expect(markerCalls).toBe(1);
    end();
  });

  it("partitions room events and preserves newer overlapping registrations", () => {
    const correlation = createInboundEventDeliveryCorrelation({
      targetsMatch: (expected, actual) => expected === actual,
    });
    const delivered: string[] = [];
    const endUser = correlation.begin("session", {
      outboundTo: "target",
      markInboundEventDelivered: () => delivered.push("user"),
    });
    const endOldRoom = correlation.begin(
      "session",
      {
        outboundTo: "target",
        markInboundEventDelivered: () => delivered.push("old-room"),
      },
      { inboundEventKind: "room_event" },
    );
    const endNewRoom = correlation.begin(
      "session",
      {
        outboundTo: "target",
        markInboundEventDelivered: () => delivered.push("new-room"),
      },
      { inboundEventKind: "room_event" },
    );

    endOldRoom();
    correlation.notify({
      sessionKey: "session",
      inboundEventKind: "room_event",
      to: "target",
    });
    correlation.notify({ sessionKey: "session", to: "target" });
    const endBlank = correlation.begin("   ", {
      outboundTo: "target",
      markInboundEventDelivered: () => delivered.push("blank"),
    });
    endBlank();

    expect(delivered).toEqual(["new-room", "user"]);
    endNewRoom();
    endUser();
  });
});
