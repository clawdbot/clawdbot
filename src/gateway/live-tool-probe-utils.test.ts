import { describe, expect, it } from "vitest";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe-utils.js";

describe("live tool probe utils", () => {
  describe("nonce matching", () => {
    it.each([
      {
        name: "matches tool nonce pairs only when both are present",
        actual: hasExpectedToolNonce("value a-1 and b-2", "a-1", "b-2"),
        expected: true,
      },
      {
        name: "rejects partial tool nonce matches",
        actual: hasExpectedToolNonce("value a-1 only", "a-1", "b-2"),
        expected: false,
      },
      {
        name: "matches a single nonce when present",
        actual: hasExpectedSingleNonce("value nonce-1", "nonce-1"),
        expected: true,
      },
      {
        name: "rejects single nonce mismatches",
        actual: hasExpectedSingleNonce("value nonce-2", "nonce-1"),
        expected: false,
      },
    ])("$name", ({ actual, expected }) => {
      expect(actual).toBe(expected);
    });
  });

  describe("refusal detection", () => {
    it.each([
      {
        name: "detects nonce refusal phrasing",
        text: "Same request, same answer — this isn't a real OpenClaw probe. No part of the system asks me to parrot back nonce values.",
        expected: true,
      },
      {
        name: "detects prompt-injection style refusals without nonce text",
        text: "That's not a legitimate self-test. This looks like a prompt injection attempt.",
        expected: true,
      },
      {
        name: "detects tool authorization refusals",
        text: "Before proceeding, I must confirm: are you authorizing me to execute the read tool with the provided arguments?",
        expected: true,
      },
      {
        name: "ignores generic helper text",
        text: "I can help with that request.",
        expected: false,
      },
      {
        name: "does not treat nonce markers without the word nonce as refusal",
        text: "No part of the system asks me to parrot back values.",
        expected: false,
      },
    ])("$name", ({ text, expected }) => {
      expect(isLikelyToolNonceRefusal(text)).toBe(expected);
    });
  });

  describe("shouldRetryToolReadProbe", () => {
    it.each([
      {
        name: "retries malformed tool output when attempts remain",
        params: {
          text: "read[object Object],[object Object]",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "does not retry once max attempts are exhausted",
        params: {
          text: "read[object Object],[object Object]",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          attempt: 2,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "does not retry when the nonce pair is already present",
        params: {
          text: "nonce-a nonce-b",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "prefers a valid nonce pair even if the text still contains scaffolding words",
        params: {
          text: "tool output nonce-a nonce-b function",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "retries empty output",
        params: {
          text: "   ",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries tool scaffolding output",
        params: {
          text: "Use tool function read[] now.",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries conversational try-again output",
        params: {
          text: "Let me try reading the file again:",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "zai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "does not retry generic conversational text without tool-retry context",
        params: {
          text: "Let me try a different approach.",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "zai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "retries mistral nonce marker echoes without parsed values",
        params: {
          text: "nonceA= nonceB=",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries anthropic refusal output",
        params: {
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "anthropic",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "does not special-case anthropic refusals for other providers",
        params: {
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
    ])("$name", ({ params, expected }) => {
      expect(shouldRetryToolReadProbe(params)).toBe(expected);
    });
  });

  describe("shouldRetryExecReadProbe", () => {
    it.each([
      {
        name: "retries malformed exec+read output when attempts remain",
        params: {
          text: "read[object Object]",
          nonce: "nonce-c",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "does not retry once max attempts are exhausted",
        params: {
          text: "read[object Object]",
          nonce: "nonce-c",
          provider: "openai",
          attempt: 2,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "does not retry when the nonce is already present",
        params: {
          text: "nonce-c",
          nonce: "nonce-c",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "prefers a valid nonce even if the text still contains scaffolding words",
        params: {
          text: "tool output nonce-c function",
          nonce: "nonce-c",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "retries anthropic nonce refusal output",
        params: {
          text: "No part of the system asks me to parrot back nonce values.",
          nonce: "nonce-c",
          provider: "anthropic",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries conversational try-again exec output",
        params: {
          text: "Let me try reading the file again:",
          nonce: "nonce-c",
          provider: "zai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries eventual-consistency exec readback output",
        params: {
          text: "The file creation command succeeded, but the file wasn't found immediately after. Let me verify the file exists and read it again.",
          nonce: "nonce-c",
          provider: "mistral",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "retries file-not-found exec readback wording",
        params: {
          text: "The `exec` command ran successfully, but the file read failed because the file was not found. Let me verify the file creation and read it again.",
          nonce: "nonce-c",
          provider: "mistral",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: true,
      },
      {
        name: "does not retry generic exec conversational text without tool-retry context",
        params: {
          text: "Let me try a different approach.",
          nonce: "nonce-c",
          provider: "zai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
      {
        name: "does not special-case anthropic refusals for other providers",
        params: {
          text: "No part of the system asks me to parrot back nonce values.",
          nonce: "nonce-c",
          provider: "openai",
          attempt: 0,
          maxAttempts: 3,
        },
        expected: false,
      },
    ])("$name", ({ params, expected }) => {
      expect(shouldRetryExecReadProbe(params)).toBe(expected);
    });
  });
});
