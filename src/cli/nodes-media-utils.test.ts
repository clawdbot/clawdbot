// Nodes media utility tests cover media argument helpers for node CLI commands.
import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  mediaPathMatchesFormat,
  resolveTempPathParts,
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

  it("detects media paths that contradict the reported format", () => {
    expect(mediaPathMatchesFormat("/out/shot.png", "jpg")).toBe(false);
    expect(mediaPathMatchesFormat("/out/clip.mov", "mp4")).toBe(false);
    expect(mediaPathMatchesFormat("C:\\out\\shot.png", "jpeg")).toBe(false);
  });

  it("accepts matching, equivalent, extensionless, and unrecognizable cases", () => {
    expect(mediaPathMatchesFormat("/out/shot.png", "png")).toBe(true);
    // `jpeg` and `jpg` are the same encoding; neither spelling contradicts it.
    expect(mediaPathMatchesFormat("/out/shot.jpeg", "jpeg")).toBe(true);
    expect(mediaPathMatchesFormat("/out/shot.jpeg", "jpg")).toBe(true);
    expect(mediaPathMatchesFormat("/out/shot.jpg", "jpeg")).toBe(true);
    // A name without an extension claims nothing about the bytes.
    expect(mediaPathMatchesFormat("/out/shot", "png")).toBe(true);
    expect(mediaPathMatchesFormat("/workspace/", "jpg")).toBe(true);
    expect(mediaPathMatchesFormat("/out/shot.png", "png/../escape")).toBe(true);
    expect(mediaPathMatchesFormat("/out/shot.png", "")).toBe(true);
  });
});
