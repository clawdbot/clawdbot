import { describe, expect, it } from "vitest";
import {
  isMatrixVerificationEventType,
  isMatrixVerificationNoticeBody,
  isMatrixVerificationRequestMsgType,
  isMatrixVerificationRoomMessage,
} from "./verification-utils.js";

describe("matrix verification message classifiers", () => {
  it("recognizes verification event types", () => {
    expect(isMatrixVerificationEventType("m.key.verification.start")).toBe(true);
    expect(isMatrixVerificationEventType("m.room.message")).toBe(false);
  });

  it("recognizes verification request message type", () => {
    expect(isMatrixVerificationRequestMsgType("m.key.verification.request")).toBe(true);
    expect(isMatrixVerificationRequestMsgType("m.text")).toBe(false);
  });

  it("recognizes verification notice bodies", () => {
    expect(
      isMatrixVerificationNoticeBody("Matrix verification started with @alice:example.org."),
    ).toBe(true);
    expect(isMatrixVerificationNoticeBody("hello world")).toBe(false);
  });

  it("classifies verification room messages", () => {
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.key.verification.request",
        body: "verify request",
      }),
    ).toBe(true);
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.notice",
        body: "Matrix verification cancelled by @alice:example.org.",
      }),
    ).toBe(true);
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.text",
        body: "normal chat message",
      }),
    ).toBe(false);
  });
});
