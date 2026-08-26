// Isolated agent helper tests cover low-level cron agent utilities.
import { describe, expect, it } from "vitest";
import { pickLastNonEmptyTextFromPayloads } from "./helpers.js";

type TextPayload = { text?: string | undefined; isError?: boolean | undefined };

const textPayloadPickerCases: Array<{
  name: string;
  pick: (payloads: TextPayload[]) => string | undefined;
  payloads: TextPayload[];
  expected: string | undefined;
}> = [
  {
    name: "last non-empty text picks real text over error payload",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [{ text: "Real output" }, { text: "Service error", isError: true }],
    expected: "Real output",
  },
  {
    name: "last non-empty text falls back to error payload when no real text exists",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [{ text: "Service error", isError: true }],
    expected: "Service error",
  },
  {
    name: "last non-empty text returns undefined for empty payloads",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [],
    expected: undefined,
  },
  {
    name: "last non-empty text treats isError: undefined as non-error",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [
      { text: "good", isError: undefined },
      { text: "bad", isError: true },
    ],
    expected: "good",
  },
];

describe("text payload pickers", () => {
  it.each(textPayloadPickerCases)("$name", ({ pick, payloads, expected }) => {
    expect(pick(payloads)).toBe(expected);
  });
});
