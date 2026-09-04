import { describe, expect, it } from "vitest";
import { formatSlackFileReference } from "./file-reference.js";

describe("formatSlackFileReference", () => {
  it.each([
    {
      name: "all Slack metadata",
      file: { id: "F123", name: "report.pdf", mimetype: "application/pdf", size: 45_056 },
      expected: "report.pdf (application/pdf, 45056 bytes, fileId: F123)",
    },
    {
      name: "metadata without a file ID",
      file: { name: "report.pdf", mimetype: "application/pdf", size: 45_056 },
      expected: "report.pdf (application/pdf, 45056 bytes)",
    },
    {
      name: "no optional metadata",
      file: { id: "F123", name: "report.pdf" },
      expected: "report.pdf (fileId: F123)",
    },
    {
      name: "an empty file and blank MIME type",
      file: { id: "FEMPTY", name: "empty.txt", mimetype: "  ", size: 0 },
      expected: "empty.txt (0 bytes, fileId: FEMPTY)",
    },
  ])("renders $name", ({ file, expected }) => {
    expect(formatSlackFileReference(file)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "omits an invalid Slack file size (%s)",
    (size) => {
      expect(
        formatSlackFileReference({
          id: "F123",
          name: "report.pdf",
          mimetype: "application/pdf",
          size,
        }),
      ).toBe("report.pdf (application/pdf, fileId: F123)");
    },
  );
});
