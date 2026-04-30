import { describe, expect, it } from "vitest";
import { parsePsCpuTimeMs, parsePsRssBytes } from "./process-tree-cpu.js";

describe("process tree CPU helpers", () => {
  it("parses ps CPU time strings", () => {
    expect(parsePsCpuTimeMs("00:01")).toBe(1_000);
    expect(parsePsCpuTimeMs("01:02")).toBe(62_000);
    expect(parsePsCpuTimeMs("01:02:03")).toBe(3_723_000);
  });

  it("rejects malformed ps CPU time strings", () => {
    expect(parsePsCpuTimeMs("")).toBeNull();
    expect(parsePsCpuTimeMs("nope")).toBeNull();
    expect(parsePsCpuTimeMs("1:2:3:4")).toBeNull();
  });

  it("parses ps RSS KiB values as bytes", () => {
    expect(parsePsRssBytes("1024")).toBe(1_048_576);
    expect(parsePsRssBytes("1.5")).toBe(1_536);
  });

  it("rejects malformed ps RSS values", () => {
    expect(parsePsRssBytes("")).toBeNull();
    expect(parsePsRssBytes("nope")).toBeNull();
    expect(parsePsRssBytes("-1")).toBeNull();
  });
});
