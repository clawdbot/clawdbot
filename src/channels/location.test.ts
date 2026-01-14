import { describe, expect, it } from "vitest";

import { formatLocationText, toLocationContext } from "./location.js";

describe("provider location helpers", () => {
  it("formats pin locations with accuracy", () => {
    const text = formatLocationText({
      latitude: 48.858844,
      longitude: 2.294351,
      accuracy: 12,
    });
    expect(text).toBe("📍 48.858844, 2.294351 ±12m");
  });

  it("formats named places with address and caption", () => {
    const text = formatLocationText({
      latitude: 40.689247,
      longitude: -74.044502,
      name: "Statue of Liberty",
      address: "Liberty Island, NY",
      accuracy: 8,
      caption: "Bring snacks",
    });
    expect(text).toBe(
      "📍 Statue of Liberty — Liberty Island, NY (40.689247, -74.044502 ±8m)\nBring snacks",
    );
  });

  it("formats live locations with live label", () => {
    const text = formatLocationText({
      latitude: 37.819929,
      longitude: -122.478255,
      accuracy: 20,
      caption: "On the move",
      isLive: true,
      source: "live",
    });
    expect(text).toBe(
      "🛰 Live location: 37.819929, -122.478255 ±20m\nOn the move",
    );
  });

  it("builds ctx fields with normalized source", () => {
    const ctx = toLocationContext({
      latitude: 1,
      longitude: 2,
      name: "Cafe",
      address: "Main St",
    });
    expect(ctx).toEqual({
      LocationLat: 1,
      LocationLon: 2,
      LocationAccuracy: undefined,
      LocationName: "Cafe",
      LocationAddress: "Main St",
      LocationSource: "place",
      LocationIsLive: false,
    });
  });
});
