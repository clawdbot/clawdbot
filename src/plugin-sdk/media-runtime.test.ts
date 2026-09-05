/**
 * Tests media runtime SDK barrel behavior.
 */
import { describe, expect, it } from "vitest";
import { isInboundPathAllowed, normalizeInboundPathRoots } from "./media-runtime.js";

describe("media-runtime SDK barrel", () => {
  it("exposes Windows drive inbound path matching case-insensitively", () => {
    const roots = ["d:/users/*/library/messages/attachments"];

    expect(normalizeInboundPathRoots(["D:/Users/*/Library/Messages/Attachments"])).toEqual(roots);
    expect(
      isInboundPathAllowed({
        filePath: "D:\\Users\\Alice\\Library\\Messages\\Attachments\\12\\34\\ABCDEF\\IMG_0001.jpeg",
        roots,
      }),
    ).toBe(true);
  });
});
