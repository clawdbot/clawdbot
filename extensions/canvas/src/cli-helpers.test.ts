import { describe, expect, it } from "vitest";
import {
  canvasSnapshotTempPath,
  normalizeCanvasSnapshotFileExtension,
  parseCanvasSnapshotPayload,
} from "./cli-helpers.js";

describe("canvas CLI helpers", () => {
  it("parses canvas.snapshot payload", () => {
    expect(parseCanvasSnapshotPayload({ format: "png", base64: "aGk=" })).toEqual({
      format: "png",
      base64: "aGk=",
    });
  });

  it("rejects invalid canvas.snapshot payload", () => {
    expect(() => parseCanvasSnapshotPayload({ format: "png" })).toThrow(
      /invalid canvas\.snapshot payload/i,
    );
  });

  it.each([{ base64: "aGk=" }, { format: 42, base64: "aGk=" }])(
    "rejects invalid canvas.snapshot format fields",
    (payload) => {
      expect(() => parseCanvasSnapshotPayload(payload)).toThrow(
        /invalid canvas\.snapshot payload/i,
      );
    },
  );

  it.each(["/../../target.sh", "../target.sh", "png/../../target.sh", "image/png", ""])(
    "rejects unsafe canvas.snapshot formats from responses: %s",
    (format) => {
      expect(() => parseCanvasSnapshotPayload({ format, base64: "aGk=" })).toThrow(
        /invalid canvas\.snapshot payload/i,
      );
    },
  );

  it("normalizes supported snapshot file extensions", () => {
    expect(normalizeCanvasSnapshotFileExtension("png")).toBe("png");
    expect(normalizeCanvasSnapshotFileExtension(".jpeg")).toBe("jpg");
    expect(normalizeCanvasSnapshotFileExtension(" JPG ")).toBe("jpg");
  });

  it("rejects unsafe snapshot temp path parts", () => {
    expect(() =>
      canvasSnapshotTempPath({
        tmpDir: "/tmp/openclaw-canvas-test",
        id: "snapshot",
        ext: "/../../target.sh",
      }),
    ).toThrow(/invalid canvas\.snapshot format/i);
    expect(() =>
      canvasSnapshotTempPath({
        tmpDir: "/tmp/openclaw-canvas-test",
        id: "../../snapshot",
        ext: "png",
      }),
    ).toThrow(/invalid canvas snapshot id/i);
  });
});
