import { describe, expect, it } from "vitest";
import {
  assertCodexThreadStartResponse,
  assertCodexThreadResumeResponse,
} from "./protocol-validators.js";

function makeMinimalThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    sessionId: "session-1",
    cliVersion: "0.129.0",
    createdAt: 1715299200,
    updatedAt: 1715299200,
    cwd: "/tmp",
    ephemeral: false,
    modelProvider: "openai",
    preview: "test thread",
    source: "appServer",
    status: { type: "notLoaded" },
    turns: [],
    ...overrides,
  };
}

function makeMinimalResponse(threadOverrides: Record<string, unknown> = {}) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp",
    model: "gpt-5.4",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: makeMinimalThread(threadOverrides),
  };
}

describe("assertCodexThreadStartResponse", () => {
  it("accepts response with both id and sessionId", () => {
    const response = makeMinimalResponse();
    const result = assertCodexThreadStartResponse(response);
    expect(result.thread).toMatchObject({ id: "thread-1", sessionId: "session-1" });
  });

  it("normalizes missing sessionId from id", () => {
    const response = makeMinimalResponse({ sessionId: undefined });
    // Remove the sessionId key entirely
    delete (response.thread as Record<string, unknown>).sessionId;
    const result = assertCodexThreadStartResponse(response);
    expect(result.thread).toMatchObject({ id: "thread-1", sessionId: "thread-1" });
  });

  it("normalizes missing id from sessionId", () => {
    const response = makeMinimalResponse({ id: undefined, sessionId: "session-1" });
    delete (response.thread as Record<string, unknown>).id;
    const result = assertCodexThreadStartResponse(response);
    expect(result.thread).toMatchObject({ id: "session-1", sessionId: "session-1" });
  });

  it("throws on invalid response", () => {
    expect(() => assertCodexThreadStartResponse({})).toThrow("Invalid Codex app-server");
  });
});

describe("assertCodexThreadResumeResponse", () => {
  it("normalizes missing sessionId from id", () => {
    const response = makeMinimalResponse({ sessionId: undefined });
    delete (response.thread as Record<string, unknown>).sessionId;
    const result = assertCodexThreadResumeResponse(response);
    expect(result.thread).toMatchObject({ id: "thread-1", sessionId: "thread-1" });
  });
});
