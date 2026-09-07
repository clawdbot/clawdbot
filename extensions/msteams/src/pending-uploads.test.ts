// Msteams tests cover pending uploads plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPendingUpload,
  removePendingUpload,
  setPendingUploadActivityId,
  storePendingUpload,
} from "./pending-uploads.js";

const createdUploadIds = new Set<string>();

function storePendingUploadForTest(upload: Parameters<typeof storePendingUpload>[0]): string {
  const id = storePendingUpload(upload);
  createdUploadIds.add(id);
  return id;
}

function requirePendingUpload(id: string) {
  const upload = getPendingUpload(id);
  if (!upload) {
    throw new Error(`expected pending upload ${id}`);
  }
  return upload;
}

describe("pending-uploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const id of createdUploadIds) {
      removePendingUpload(id);
    }
    createdUploadIds.clear();
    vi.useRealTimers();
  });

  describe("storePendingUpload", () => {
    it("stores and retrieves a pending upload", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        contentType: "text/plain",
        conversationId: "conv-1",
      });

      const upload = requirePendingUpload(id);
      expect(upload.id).toBe(id);
      expect(upload.buffer.toString()).toBe("data");
      expect(upload.filename).toBe("file.txt");
      expect(upload.contentType).toBe("text/plain");
      expect(upload.conversationId).toBe("conv-1");
      expect(upload.createdAt).toBe(Date.now());
    });

    it("stores consentCardActivityId when provided", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
        consentCardActivityId: "activity-abc",
      });

      const upload = getPendingUpload(id);
      expect(upload?.consentCardActivityId).toBe("activity-abc");
    });

    it("stores without consentCardActivityId when not provided", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      const upload = getPendingUpload(id);
      expect(upload?.consentCardActivityId).toBeUndefined();
    });

    it("auto-removes entry after TTL expires", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(requirePendingUpload(id).filename).toBe("file.txt");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      // After TTL the in-memory check also gates access
      expect(getPendingUpload(id)).toBeUndefined();
    });
  });

  describe("removePendingUpload", () => {
    it("removes the entry immediately", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      removePendingUpload(id);
      expect(getPendingUpload(id)).toBeUndefined();
    });

    it("clears the TTL timer so it does not fire after explicit removal", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(getPendingUpload(id)).toBeDefined();
      removePendingUpload(id);
      expect(getPendingUpload(id)).toBeUndefined();

      // Advance past TTL — timer should have been cleared and count stays 0
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getPendingUpload(id)).toBeUndefined();
    });

    it("leaves existing uploads untouched for undefined id", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      removePendingUpload(undefined);
      expect(getPendingUpload(id)).toBeDefined();
    });

    it("leaves the store empty for unknown ids", () => {
      removePendingUpload("non-existent-id");
      expect(getPendingUpload("non-existent-id")).toBeUndefined();
    });
  });

  describe("setPendingUploadActivityId", () => {
    it("sets the consentCardActivityId on an existing upload", () => {
      const id = storePendingUploadForTest({
        buffer: Buffer.from("data"),
        filename: "file.txt",
        conversationId: "conv-1",
      });

      expect(getPendingUpload(id)?.consentCardActivityId).toBeUndefined();

      setPendingUploadActivityId(id, "activity-xyz");
      expect(getPendingUpload(id)?.consentCardActivityId).toBe("activity-xyz");
    });

    it("leaves the store empty for unknown upload ids", () => {
      setPendingUploadActivityId("non-existent", "activity-xyz");
      expect(getPendingUpload("non-existent")).toBeUndefined();
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
      const id = storePendingUploadForTest({
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
