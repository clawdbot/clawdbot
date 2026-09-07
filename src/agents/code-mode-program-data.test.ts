import { describe, expect, it, vi } from "vitest";
import { CodeModeProgramDataInbox } from "./code-mode-program-data.js";

const limits = { memoryLimitBytes: 1024, maxSnapshotBytes: 2048, maxOutputBytes: 1024 };

describe("Code Mode reply leases", () => {
  it.each([true, false])(
    "charges complete success/error JSON at settlement and reuses released capacity (ok=%s)",
    (ok) => {
      const inbox = new CodeModeProgramDataInbox(limits);
      const first = inbox.createReply("first");
      const second = inbox.createReply("second");
      const payload = "x".repeat(1022);
      first.settle(ok, payload);
      second.settle(true, null);
      const retained = first.take();
      expect(retained).toEqual({ id: "first", ok, json: JSON.stringify(payload) });
      const refused = second.take();
      expect(refused.ok).toBe(false);
      expect(JSON.parse(refused.json)).toMatch(/program-data budget exceeded/);
      expect(Buffer.byteLength(refused.json)).toBeLessThan(200);
      first.release();
      first.release();
      expect(retained.json).toBe("");
      const next = inbox.createReply("next");
      next.settle(ok, payload);
      expect(next.take().json).toBe(JSON.stringify(payload));
      next.release();
      second.release();
      inbox.close();
    },
  );

  it.each([
    { memoryLimitBytes: 1024, maxSnapshotBytes: 2048 },
    { memoryLimitBytes: 2048, maxSnapshotBytes: 1024 },
  ])("uses the smaller existing limit, not a per-result or display limit: %j", (cap) => {
    const inbox = new CodeModeProgramDataInbox({ ...cap, maxOutputBytes: 32 });
    const first = inbox.createReply("first");
    first.settle(true, "x".repeat(600));
    const second = inbox.createReply("second");
    second.settle(true, "x".repeat(600));
    expect(JSON.parse(first.take().json)).toHaveLength(600);
    expect(second.take().ok).toBe(false);
    first.release();
    second.release();
    inbox.close();
  });

  it("preserves normalized Unicode, escaping, and marker-shaped user data", () => {
    const inbox = new CodeModeProgramDataInbox(limits);
    const reply = inbox.createReply("unicode");
    const value = { text: '🦞\n"\\', truncated: true, value: Number.NaN, absent: undefined };
    reply.settle(true, value);
    expect(reply.take().json).toBe(JSON.stringify(value));
    reply.release();
    inbox.close();
  });

  it("fences canceled and closed late completions before normalization", () => {
    const inbox = new CodeModeProgramDataInbox(limits);
    const canceled = inbox.createReply("canceled");
    canceled.cancel();
    const closed = inbox.createReply("closed");
    inbox.close();
    const late = inbox.createReply("late");
    const toJSON = vi.fn(() => "must not retain");
    for (const reply of [canceled, closed, late]) {
      reply.settle(true, { toJSON });
      reply.settle(false, "late failure".repeat(10000));
      expect(() => reply.take()).toThrow("unavailable");
    }
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rechecks lifetime after tool-owned normalization", () => {
    const inbox = new CodeModeProgramDataInbox(limits);
    const reply = inbox.createReply("reentrant");
    reply.settle(true, {
      toJSON() {
        inbox.close();
        return "large".repeat(10000);
      },
    });
    expect(() => reply.take()).toThrow("unavailable");
  });

  it("keeps in-flight ownership until delivery release but clears parked replies on cancel", () => {
    const inbox = new CodeModeProgramDataInbox(limits);
    const inFlight = inbox.createReply("in-flight");
    const parked = inbox.createReply("parked");
    inFlight.settle(true, "first".repeat(50));
    parked.settle(false, "failure".repeat(50));
    const alias = inFlight.take();
    inbox.close();
    expect(alias.json).toBe(JSON.stringify("first".repeat(50)));
    expect(() => parked.take()).toThrow("unavailable");
    inFlight.release();
    expect(alias.json).toBe("");
  });

  it("bounds arbitrary tool errors before retaining them", () => {
    const inbox = new CodeModeProgramDataInbox(limits);
    const reply = inbox.createReply("error");
    reply.settle(false, "cause:" + "🦞".repeat(10000));
    const result = reply.take();
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1024);
    expect(JSON.parse(result.json)).toMatch(/^cause:.*\[error truncated\]$/);
    reply.release();
    inbox.close();
  });
});
