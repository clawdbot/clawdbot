// Covers system-message marking and prefix idempotence.
import { describe, expect, it } from "vitest";
import { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "./system-message.js";

describe("system-message", () => {
  it.each([
    {
      input: "thread notice",
      prefixed: `${SYSTEM_MARK} thread notice`,
      marked: false,
    },
    {
      input: `  thread notice  `,
      prefixed: `${SYSTEM_MARK} thread notice`,
      marked: false,
    },
    {
      input: "   ",
      prefixed: "",
      marked: false,
    },
    {
      input: `${SYSTEM_MARK} already prefixed`,
      prefixed: `${SYSTEM_MARK} already prefixed`,
      marked: true,
    },
    {
      input: `  ${SYSTEM_MARK} hello`,
      prefixed: `${SYSTEM_MARK} hello`,
      marked: true,
    },
    {
      input: SYSTEM_MARK,
      prefixed: SYSTEM_MARK,
      marked: true,
    },
    {
      input: `  ${SYSTEM_MARK}  `,
      prefixed: SYSTEM_MARK,
      marked: true,
    },
    {
      input: "",
      prefixed: "",
      marked: false,
    },
    {
      input: "hello",
      prefixed: `${SYSTEM_MARK} hello`,
      marked: false,
    },
  ])("handles %j", ({ input, prefixed, marked }) => {
    expect(prefixSystemMessage(input)).toBe(prefixed);
    expect(hasSystemMark(input)).toBe(marked);
  });
});
