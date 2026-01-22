import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import * as pendingUploads from "./pending-uploads.js";

describe("requiresFileConsent", () => {
  const thresholdBytes = 4 * 1024 * 1024; // 4MB

  it("returns true for personal chat with non-image", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "application/pdf",
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns true for personal chat with large image", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/png",
        bufferSize: 5 * 1024 * 1024, // 5MB
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false for personal chat with small image", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/png",
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns false for group chat with large non-image", () => {
    expect(
      requiresFileConsent({
        conversationType: "groupChat",
        contentType: "application/pdf",
        bufferSize: 5 * 1024 * 1024,
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns false for channel with large non-image", () => {
    expect(
      requiresFileConsent({
        conversationType: "channel",
        contentType: "application/pdf",
        bufferSize: 5 * 1024 * 1024,
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("handles case-insensitive conversation type", () => {
    expect(
      requiresFileConsent({
        conversationType: "Personal",
        contentType: "application/pdf",
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(true);

    expect(
      requiresFileConsent({
        conversationType: "PERSONAL",
        contentType: "application/pdf",
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false when conversationType is undefined", () => {
    expect(
      requiresFileConsent({
        conversationType: undefined,
        contentType: "application/pdf",
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(false);
  });

  it("returns true for personal chat when contentType is undefined (non-image)", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: undefined,
        bufferSize: 1000,
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns true for personal chat with file exactly at threshold", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/jpeg",
        bufferSize: thresholdBytes, // exactly 4MB
        thresholdBytes,
      }),
    ).toBe(true);
  });

  it("returns false for personal chat with file just below threshold", () => {
    expect(
      requiresFileConsent({
        conversationType: "personal",
        contentType: "image/jpeg",
        bufferSize: thresholdBytes - 1, // 4MB - 1 byte
        thresholdBytes,
      }),
    ).toBe(false);
  });
});

describe("prepareFileConsentActivity", () => {
  const mockUploadId = "test-upload-id-123";

  beforeEach(() => {
    vi.spyOn(pendingUploads, "storePendingUpload").mockReturnValue(mockUploadId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates activity with consent card attachment", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test content"),
        filename: "test.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv123",
      description: "My file",
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
    expect(result.activity.attachments).toHaveLength(1);

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, unknown>;
    expect(attachment.contentType).toBe("application/vnd.microsoft.teams.card.file.consent");
    expect(attachment.name).toBe("test.pdf");
  });

  it("stores pending upload with correct data", () => {
    const buffer = Buffer.from("test content");
    prepareFileConsentActivity({
      media: {
        buffer,
        filename: "test.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv123",
      description: "My file",
    });

    expect(pendingUploads.storePendingUpload).toHaveBeenCalledWith({
      buffer,
      filename: "test.pdf",
      contentType: "application/pdf",
      conversationId: "conv123",
    });
  });

  it("uses default description when not provided", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "document.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      conversationId: "conv456",
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, { description: string }>;
    expect(attachment.content.description).toBe("File: document.docx");
  });

  it("uses provided description", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      conversationId: "conv789",
      description: "Q4 Financial Report",
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, { description: string }>;
    expect(attachment.content.description).toBe("Q4 Financial Report");
  });

  it("includes uploadId in consent card context", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("test"),
        filename: "file.txt",
        contentType: "text/plain",
      },
      conversationId: "conv000",
    });

    const attachment = (result.activity.attachments as unknown[])[0] as Record<string, { acceptContext: { uploadId: string } }>;
    expect(attachment.content.acceptContext.uploadId).toBe(mockUploadId);
  });

  it("handles media without contentType", () => {
    const result = prepareFileConsentActivity({
      media: {
        buffer: Buffer.from("binary data"),
        filename: "unknown.bin",
      },
      conversationId: "conv111",
    });

    expect(result.uploadId).toBe(mockUploadId);
    expect(result.activity.type).toBe("message");
  });
});
