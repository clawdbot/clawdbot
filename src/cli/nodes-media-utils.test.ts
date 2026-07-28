// Nodes media utility tests cover media argument helpers for node CLI commands.
import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  resolveTempPathParts,
  withMediaFileExtension,
} from "./nodes-media-utils.js";

describe("cli/nodes-media-utils", () => {
  it("parses primitive helper values", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord("x")).toStrictEqual({});
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(asNumber(1)).toBe(1);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(1)).toBeUndefined();
  });

  it("normalizes temp path parts", () => {
    expect(resolveTempPathParts({ ext: "png", tmpDir: "/tmp", id: "id1" })).toEqual({
      tmpDir: "/tmp",
      id: "id1",
      ext: ".png",
    });
    expect(resolveTempPathParts({ ext: ".jpg", tmpDir: "/tmp", id: "id2" }).ext).toBe(".jpg");
  });

  it("renames a media path to the extension matching the reported format", () => {
    expect(withMediaFileExtension("/out/shot.png", "jpg")).toBe("/out/shot.jpg");
    expect(withMediaFileExtension("/out/clip.mov", "mp4")).toBe("/out/clip.mp4");
    expect(withMediaFileExtension("/out/shot", "png")).toBe("/out/shot.png");
    expect(withMediaFileExtension("C:\\out\\shot.png", "jpeg")).toBe("C:\\out\\shot.jpg");
  });

  it("leaves matching, equivalent, and unrecognizable formats alone", () => {
    expect(withMediaFileExtension("/out/shot.png", "png")).toBe("/out/shot.png");
    // `jpeg` and `jpg` are the same encoding; do not churn the caller's spelling.
    expect(withMediaFileExtension("/out/shot.jpeg", "jpeg")).toBe("/out/shot.jpeg");
    expect(withMediaFileExtension("/out/shot.jpeg", "jpg")).toBe("/out/shot.jpeg");
    expect(withMediaFileExtension("/out/shot.png", "png/../escape")).toBe("/out/shot.png");
    expect(withMediaFileExtension("/out/shot.png", "")).toBe("/out/shot.png");
  });
});
