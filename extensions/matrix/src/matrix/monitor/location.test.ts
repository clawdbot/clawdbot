import { describe, expect, it } from "vitest";
import { resolveMatrixLocation } from "./location.js";
import { EventType } from "./types.js";

describe("resolveMatrixLocation", () => {
  it("decodes encoded geo uri accuracy", () => {
    const result = resolveMatrixLocation({
      eventType: EventType.Location,
      content: {
        msgtype: EventType.Location,
        geo_uri: "geo:1.5,2.5;u=%31%30",
      },
    });

    expect(result?.context).toMatchObject({
      LocationLat: 1.5,
      LocationLon: 2.5,
      LocationAccuracy: 10,
    });
  });

  it("ignores malformed geo uri parameter encoding", () => {
    const result = resolveMatrixLocation({
      eventType: EventType.Location,
      content: {
        msgtype: EventType.Location,
        geo_uri: "geo:1.5,2.5;u=%zz",
      },
    });

    expect(result?.context).toMatchObject({
      LocationLat: 1.5,
      LocationLon: 2.5,
    });
    expect(result?.context.LocationAccuracy).toBeUndefined();
  });
});
