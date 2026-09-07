// Matrix tests cover media attachment text behavior.
import { describe, expect, it } from "vitest";
import { formatMatrixMessageText, resolveMatrixMessageAttachment } from "./media-text.js";

// Remote peers control msgtype; names that collide with Object.prototype keys
// must stay plain text, not become inherited lookup values misclassified as media.
describe("resolveMatrixMessageAttachment", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "does not treat Object.prototype names as media kinds (%s)",
    (msgtype) => {
      expect(resolveMatrixMessageAttachment({ body: "hi", msgtype })).toBeUndefined();
    },
  );
});

describe("formatMatrixMessageText", () => {
  it.each(["constructor", "__proto__"])(
    "keeps prototype-named msgtypes as plain text (%s)",
    (msgtype) => {
      expect(formatMatrixMessageText({ body: "hi", msgtype })).toBe("hi");
    },
  );
});
