import { describe, expect, it } from "vitest";
import {
  FeishuBackoffError,
  getBackoffCodeFromResponse,
  isFeishuBackoffError,
} from "./typing-backoff.js";

describe("isFeishuBackoffError", () => {
  it.each([
    { name: "HTTP 429 with data", error: { response: { status: 429, data: {} } }, expected: true },
    {
      name: "Feishu quota response",
      error: { response: { status: 200, data: { code: 99991403 } } },
      expected: true,
    },
    {
      name: "Feishu rate-limit response",
      error: { response: { status: 200, data: { code: 99991400 } } },
      expected: true,
    },
    { name: "SDK HTTP code", error: { code: 429, message: "too many requests" }, expected: true },
    {
      name: "SDK quota code",
      error: { code: 99991403, message: "quota exceeded" },
      expected: true,
    },
    { name: "other HTTP error", error: { response: { status: 500, data: {} } }, expected: false },
    {
      name: "other Feishu response code",
      error: { response: { status: 200, data: { code: 99991401 } } },
      expected: false,
    },
    { name: "generic Error", error: new Error("network timeout"), expected: false },
    { name: "null", error: null, expected: false },
    { name: "undefined", error: undefined, expected: false },
    { name: "string code", error: "429", expected: false },
    { name: "HTTP 429 without data", error: { response: { status: 429 } }, expected: true },
  ])("classifies $name", ({ error, expected }) => {
    expect(isFeishuBackoffError(error)).toBe(expected);
  });
});

describe("getBackoffCodeFromResponse", () => {
  it.each([
    {
      name: "quota exceeded",
      response: { code: 99991403, msg: "quota exceeded", data: null },
      expected: 99991403,
    },
    {
      name: "rate limit",
      response: { code: 99991400, msg: "rate limit", data: null },
      expected: 99991400,
    },
    {
      name: "HTTP rate limit",
      response: { code: 429, msg: "too many requests", data: null },
      expected: 429,
    },
    {
      name: "success",
      response: { code: 0, msg: "success", data: { reaction_id: "r1" } },
      expected: undefined,
    },
    {
      name: "other error",
      response: { code: 99991401, msg: "other error", data: null },
      expected: undefined,
    },
    { name: "null", response: null, expected: undefined },
    { name: "undefined", response: undefined, expected: undefined },
    { name: "missing code", response: { data: { reaction_id: "r1" } }, expected: undefined },
  ])("reads the backoff code from $name", ({ response, expected }) => {
    expect(getBackoffCodeFromResponse(response)).toBe(expected);
  });
});

describe("FeishuBackoffError", () => {
  it.each([
    { code: 99991403, message: "Feishu API backoff: code 99991403" },
    { code: 99991400, message: "Feishu API backoff: code 99991400" },
  ])("preserves the backoff error contract for $code", ({ code, message }) => {
    const error = new FeishuBackoffError(code);
    expect(isFeishuBackoffError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FeishuBackoffError");
    expect(error.message).toBe(message);
    expect(error.code).toBe(code);
  });
});
