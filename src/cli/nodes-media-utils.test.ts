import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
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
});
