// Test support covers the poll-comment folder: a native poll's caption is an inline reply to
// the poll balloon (its reply_to_guid == the poll's guid) that lands WITH the
// poll, and must be folded (dropped) rather than delivered as a standalone
// message the agent answers in prose. A deliberate later reply, or a different
// sender's reply, must NOT be folded.
import { describe, expect, it } from "vitest";
import { createPollCommentFolder } from "./poll-comment.js";

const POLL_GUID = "75A8F623-947D-4611-A23D-4DDD6D17BC0F";
const T0 = 1_000_000; // arbitrary base timestamp (ms)

describe("createPollCommentFolder", () => {
  it("folds a caption whose reply_to_guid targets a poll that lands with it", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    // Caption ships with the poll — same instant, same sender.
    expect(folder.isPollComment(POLL_GUID, T0 + 500, "+15551110000")).toBe(true);
  });

  it("does NOT fold a deliberate later inline reply to the poll", () => {
    const folder = createPollCommentFolder({ windowMs: 15_000 });
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    // A real "I can't make it" reply a minute later must be delivered.
    expect(folder.isPollComment(POLL_GUID, T0 + 60_000, "+15551110000")).toBe(false);
  });

  it("does NOT fold an in-window reply from a different sender (group member)", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isPollComment(POLL_GUID, T0 + 500, "+15559998888")).toBe(false);
  });

  it("does NOT fold when the reply sender is known but the poll sender is unknown", () => {
    // Fail closed: an unknown-sender poll row must not turn a real in-window
    // reply from an identified participant into a dropped message. This fold
    // runs before the normal missing-sender/allowlist gate.
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, undefined);
    expect(folder.isPollComment(POLL_GUID, T0 + 500, "+15551110000")).toBe(false);
  });

  it("does NOT fold when the reply sender is unknown", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isPollComment(POLL_GUID, T0 + 500, undefined)).toBe(false);
  });

  it("does not fold a reply to an unrelated message", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isPollComment("SOME-OTHER-GUID", T0, "+15551110000")).toBe(false);
  });

  it("does not fold a non-reply or a reply with no usable timestamp", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isPollComment(null, T0)).toBe(false);
    expect(folder.isPollComment("", T0)).toBe(false);
    expect(folder.isPollComment(POLL_GUID, Number.NaN)).toBe(false);
  });

  it("does not track a poll without a usable timestamp or guid", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, Number.NaN, "+15551110000");
    expect(folder.isPollComment(POLL_GUID, T0)).toBe(false);
    folder.rememberPoll(null, T0, "+15551110000");
    expect(folder.isPollComment("", T0)).toBe(false);
  });

  it("does not fold before the poll has been seen (ordering safety)", () => {
    const folder = createPollCommentFolder();
    expect(folder.isPollComment(POLL_GUID, T0, "+15551110000")).toBe(false);
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isPollComment(POLL_GUID, T0, "+15551110000")).toBe(true);
  });
});
