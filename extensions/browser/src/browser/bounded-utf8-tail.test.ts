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
});
