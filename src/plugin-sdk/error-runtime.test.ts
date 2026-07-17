/**
 * Locks the plugin SDK facade surface for error-runtime.
 *
 * This is a runtime+type smoke test: importing through the SDK subpath must
 * yield the same `isReplySessionInitConflictError` function exported by the
 * shared core module, and calling it through the SDK re-export must produce
 * the same answer as calling the core module directly.
 */
import { describe, expect, it } from "vitest";
import {
  ReplySessionInitConflictError,
  isReplySessionInitConflictError as coreIsReplySessionInitConflictError,
} from "../auto-reply/reply/session-init-conflict-error.js";
import { isReplySessionInitConflictError as sdkIsReplySessionInitConflictError } from "./error-runtime.js";

const SESSION_KEY = "agent:main:main";

describe("openclaw/plugin-sdk/error-runtime — isReplySessionInitConflictError", () => {
  it("re-exports the same function as the shared core module", () => {
    expect(sdkIsReplySessionInitConflictError).toBe(coreIsReplySessionInitConflictError);
  });

  it("matches a real ReplySessionInitConflictError through the SDK facade", () => {
    const err = new ReplySessionInitConflictError(SESSION_KEY);
    expect(sdkIsReplySessionInitConflictError(err)).toBe(true);
  });

  it("matches an Error with the anchored conflict message through the SDK facade", () => {
    const err = new Error(`reply session initialization conflicted for ${SESSION_KEY}`);
    expect(sdkIsReplySessionInitConflictError(err)).toBe(true);
  });

  it("rejects unrelated Errors through the SDK facade", () => {
    expect(sdkIsReplySessionInitConflictError(new Error("not a conflict"))).toBe(false);
  });

  it("rejects null / undefined / non-conflict objects through the SDK facade", () => {
    expect(sdkIsReplySessionInitConflictError(null)).toBe(false);
    expect(sdkIsReplySessionInitConflictError(undefined)).toBe(false);
    expect(sdkIsReplySessionInitConflictError({})).toBe(false);
  });

  it("walks cause chains through the SDK facade", () => {
    const inner = new ReplySessionInitConflictError(SESSION_KEY);
    expect(sdkIsReplySessionInitConflictError({ cause: inner })).toBe(true);
    expect(sdkIsReplySessionInitConflictError(new Error("wrap", { cause: inner }))).toBe(true);
  });
});
