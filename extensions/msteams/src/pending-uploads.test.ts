import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingUploads,
  getPendingUpload,
  getPendingUploadCount,
  removePendingUpload,
  setPendingUploadActivityId,
  storePendingUpload,
} from "./pending-uploads.js";

describe("pending-uploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingUploads();
  });

  afterEach(() => {
    clearPendingUploads();
    vi.useRealTimers();
  });

  describe("storePendingUpload", () => {
    it("stores and retrieves a pending upload", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        contentType: "text/plain",
        conversationId: "conv-1",
      });

      const upload = getPendingUpload(id);
      expect(upload).toBeDefined();
      expect(upload?.filename).toBe("file.txt");
      expect(upload?.conversationId).toBe("conv-1");
    });

    it("stores consentCardActivityId when provided", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
        consentCardActivityId: "activity-abc",
      });

      const upload = getPendingUpload(id);
      expect(upload?.consentCardActivityId).toBe("activity-abc");
    });

    it("stores without consentCardActivityId when not provided", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      const upload = getPendingUpload(id);
      expect(upload?.consentCardActivityId).toBeUndefined();
    });

    it("auto-removes entry after TTL expires", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(getPendingUpload(id)).toBeDefined();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      // After TTL the in-memory check also gates access
      expect(getPendingUpload(id)).toBeUndefined();
    });
  });

  describe("removePendingUpload", () => {
    it("removes the entry immediately", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      removePendingUpload(id);
      expect(getPendingUpload(id)).toBeUndefined();
    });

    it("clears the TTL timer so it does not fire after explicit removal", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(getPendingUploadCount()).toBe(1);
      removePendingUpload(id);
      expect(getPendingUploadCount()).toBe(0);

      // Advance past TTL — timer should have been cleared and count stays 0
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getPendingUploadCount()).toBe(0);
    });

    it("is a no-op for undefined id", () => {
      storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(() => removePendingUpload(undefined)).not.toThrow();
      expect(getPendingUploadCount()).toBe(1);
    });

    it("is a no-op for unknown id", () => {
      expect(() => removePendingUpload("non-existent-id")).not.toThrow();
    });
  });

  describe("clearPendingUploads", () => {
    it("removes all entries and cancels timers", () => {
      storePendingUpload({ buffer: Buffer.from("a"), filename: "a.txt", conversationId: "c1" });
      storePendingUpload({ buffer: Buffer.from("b"), filename: "b.txt", conversationId: "c2" });
      expect(getPendingUploadCount()).toBe(2);

      clearPendingUploads();
      expect(getPendingUploadCount()).toBe(0);

      // TTL timers should have been cleared — no side-effects after advance
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getPendingUploadCount()).toBe(0);
    });
  });

  describe("setPendingUploadActivityId", () => {
    it("sets the consentCardActivityId on an existing upload", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(getPendingUpload(id)?.consentCardActivityId).toBeUndefined();

      setPendingUploadActivityId(id, "activity-xyz");
      expect(getPendingUpload(id)?.consentCardActivityId).toBe("activity-xyz");
    });

    it("is a no-op for unknown upload id", () => {
      expect(() => setPendingUploadActivityId("non-existent", "activity-xyz")).not.toThrow();
    });
  });

  describe("getPendingUpload", () => {
    it("returns undefined for undefined id", () => {
      expect(getPendingUpload(undefined)).toBeUndefined();
    });

    it("returns undefined for unknown id", () => {
      expect(getPendingUpload("no-such-id")).toBeUndefined();
    });

    it("returns undefined when entry is past TTL but timer has not yet fired", () => {
      const id = storePendingUpload({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      // Manually advance time without firing timers to simulate stale entry
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      expect(getPendingUpload(id)).toBeUndefined();
    });
  });
});
