import { describe, expect, it } from "vitest";
import { isNewerBuzzRevision } from "./event-order.js";

describe("isNewerBuzzRevision", () => {
  it.each([
    {
      name: "missing current",
      candidate: { createdAt: 10, eventId: "b" },
      current: undefined,
      expected: true,
    },
    {
      name: "newer timestamp",
      candidate: { createdAt: 11, eventId: "b" },
      current: { createdAt: 10, eventId: "a" },
      expected: true,
    },
    {
      name: "older timestamp",
      candidate: { createdAt: 9, eventId: "a" },
      current: { createdAt: 10, eventId: "b" },
      expected: false,
    },
    {
      name: "lower ID at equal timestamp",
      candidate: { createdAt: 10, eventId: "a" },
      current: { createdAt: 10, eventId: "b" },
      expected: true,
    },
    {
      name: "higher ID at equal timestamp",
      candidate: { createdAt: 10, eventId: "b" },
      current: { createdAt: 10, eventId: "a" },
      expected: false,
    },
    {
      name: "identical revision",
      candidate: { createdAt: 10, eventId: "a" },
      current: { createdAt: 10, eventId: "a" },
      expected: false,
    },
  ])("$name", ({ candidate, current, expected }) => {
    expect(isNewerBuzzRevision(candidate, current)).toBe(expected);
  });
});
