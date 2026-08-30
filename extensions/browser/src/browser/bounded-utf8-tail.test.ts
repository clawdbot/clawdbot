import { describe, expect, it } from "vitest";
import { createBoundedUtf8Tail, decodeBoundedUtf8Tail } from "./bounded-utf8-tail.js";

describe("bounded UTF-8 tail", () => {
  it("keeps the newest bytes across several chunks", () => {
    const tail = createBoundedUtf8Tail(8);
    tail.append("older");
    tail.append("-newest");

    expect(tail.text()).toBe("r-newest");
  });

  it("drops a partial leading code point after byte truncation", () => {
    const encoded = Buffer.from(`old🦞new`);

    expect(decodeBoundedUtf8Tail(encoded, 5)).toBe("new");
  });

  it("drops a partial trailing code point after byte truncation", () => {
    const encoded = Buffer.from([0xf0, 0x9f, 0x98, 0x80]);

    expect(decodeBoundedUtf8Tail(encoded, 1)).toBe("");
  });

  it("replaces the retained tail when one chunk fills the limit", () => {
    const tail = createBoundedUtf8Tail(4);
    tail.append("old");
    tail.append("123456");

    expect(tail.text()).toBe("3456");
    tail.clear();
    expect(tail.text()).toBe("");
  });

  it("copies bytes out of caller-owned buffers", () => {
    const tail = createBoundedUtf8Tail(4);
    const source = Buffer.from("test");
    tail.append(source);
    source.fill(0);

    expect(tail.text()).toBe("test");
  });

  it("waits for split UTF-8 code points before decoding them", () => {
    const tail = createBoundedUtf8Tail(4);
    const encoded = Buffer.from([0xf0, 0x9f, 0x98, 0x80]);
    tail.append(encoded.subarray(0, 1));

    expect(tail.text()).toBe("");

    tail.append(encoded.subarray(1));

    expect(tail.text()).toBe("\u{1f600}");
  });
});
