import { describe, expect, it } from "vitest";
import { decodeHtmlEntitiesInObject } from "./tool-call-argument-decoding.js";

describe("decodeHtmlEntitiesInObject", () => {
  it("decodes valid HTML entities in nested tool arguments", () => {
    expect(
      decodeHtmlEntitiesInObject({
        query: "Rock &amp; Roll &#65; &#39;ok&#39;",
      }),
    ).toEqual({
      query: "Rock & Roll A 'ok'",
    });
  });

  it("preserves invalid numeric HTML entities", () => {
    expect(
      decodeHtmlEntitiesInObject({
        query: "bad &#x110000; and &#9999999999;",
      }),
    ).toEqual({
      query: "bad &#x110000; and &#9999999999;",
    });
  });
});
