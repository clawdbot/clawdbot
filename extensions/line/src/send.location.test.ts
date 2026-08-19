// Line tests cover how an unrenderable location reaches the chat.
import { describe, expect, it } from "vitest";
import { createLocationMessage } from "./send.js";

describe("createLocationMessage", () => {
  it("keeps a renderable location as a pin", () => {
    const message = createLocationMessage({
      title: "Blue Bottle",
      address: "1 Main Street",
      latitude: 35.6895,
      longitude: 139.6917,
    });

    expect(message).toEqual({
      type: "location",
      title: "Blue Bottle",
      address: "1 Main Street",
      latitude: 35.6895,
      longitude: 139.6917,
    });
  });

  it.each([
    { name: "title", title: " ", address: "1 Main Street", kept: "1 Main Street" },
    { name: "address", title: "Blue Bottle", address: " ", kept: "Blue Bottle" },
  ])(
    "delivers a blank-$name location as the values the sender wrote",
    ({ title, address, kept }) => {
      // LINE rejects the pin, but the sender's label and coordinates are still
      // deliverable, so they must reach the chat instead of being dropped.
      const message = createLocationMessage({
        title,
        address,
        latitude: 35.6895,
        longitude: 139.6917,
      });

      expect(message).toEqual({ type: "text", text: `${kept}\n35.6895, 139.6917` });
    },
  );

  it("caps an oversized label so the fallback stays inside LINE's text limit", () => {
    // Nothing bounds the label at the schema, so an unbounded fallback would be
    // rejected for length and lose the location exactly as before.
    const message = createLocationMessage({
      title: "A".repeat(6000),
      address: " ",
      latitude: 35.6895,
      longitude: 139.6917,
    });

    expect(message.type).toBe("text");
    const text = (message as { text: string }).text;
    expect(text).toBe("A".repeat(100) + String.fromCharCode(10) + "35.6895, 139.6917");
    expect(text.length).toBeLessThanOrEqual(5000);
  });

  it("still delivers the coordinates when the sender left both labels blank", () => {
    const message = createLocationMessage({
      title: "  ",
      address: "",
      latitude: 35.6895,
      longitude: 139.6917,
    });

    expect(message).toEqual({ type: "text", text: "35.6895, 139.6917" });
  });
});
