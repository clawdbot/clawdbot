import { describe, expect, it } from "vitest";

import { extractLinksFromMessage } from "./detect.js";

describe("extractLinksFromMessage", () => {
  it("extracts bare http/https URLs in order", () => {
    const links = extractLinksFromMessage("see https://a.example and http://b.test");
    expect(links).toEqual(["https://a.example", "http://b.test"]);
  });

  it("dedupes links and enforces maxLinks", () => {
    const links = extractLinksFromMessage("https://a.example https://a.example https://b.test", {
      maxLinks: 1,
    });
    expect(links).toEqual(["https://a.example"]);
  });

  it("ignores markdown links", () => {
    const links = extractLinksFromMessage("[doc](https://docs.example) https://bare.example");
    expect(links).toEqual(["https://bare.example"]);
  });

  it("blocks 127.0.0.1", () => {
    const links = extractLinksFromMessage("http://127.0.0.1/test https://ok.test");
    expect(links).toEqual(["https://ok.test"]);
  });
});
