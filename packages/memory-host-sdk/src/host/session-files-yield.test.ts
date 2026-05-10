import { afterEach, describe, expect, it, vi } from "vitest";

const { fileState } = vi.hoisted(() => ({
  fileState: { raw: "" },
}));

vi.mock("./fs-utils.js", () => ({
  readRegularFile: vi.fn(async () => ({
    buffer: Buffer.from(fileState.raw, "utf-8"),
  })),
  statRegularFile: vi.fn(async () => ({
    missing: false,
    stat: {
      mtimeMs: 1,
      size: Buffer.byteLength(fileState.raw, "utf-8"),
    },
  })),
}));

import { buildSessionEntry } from "./session-files.js";

describe("buildSessionEntry responsiveness", () => {
  afterEach(() => {
    fileState.raw = "";
    vi.clearAllMocks();
  });

  it("yields while parsing a single large transcript", async () => {
    fileState.raw = Array.from({ length: 25 }, (_value, index) =>
      JSON.stringify({
        type: "message",
        message: { role: "user", content: `message ${index}` },
      }),
    ).join("\n");
    let immediateRan = false;
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateRan = true;
        resolve();
      });
    });

    const entry = await buildSessionEntry("/tmp/session.jsonl", {
      generatedByCronRun: false,
      generatedByDreamingNarrative: false,
      parseYieldEveryLines: 10,
    });

    expect(entry?.lineMap).toHaveLength(25);
    expect(immediateRan).toBe(true);
    await immediate;
  });
});
