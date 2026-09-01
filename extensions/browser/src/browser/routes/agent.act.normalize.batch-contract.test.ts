// Browser tests cover agent.act.normalize batch contract behavior.
// Locks the documented `openclaw browser batch` examples against the real
// /act normalizer so a doc example the route rejects cannot slip back in.
import { describe, expect, it } from "vitest";
import { normalizeActRequest } from "./agent.act.normalize.js";

// The documented example shipped in `browser-cli-examples.ts`, `docs/cli/browser.md`,
// and `docs/tools/browser-control.md`. Every entry must be a real BrowserActRequest
// kind or the /act normalizer rejects it before dispatch.
const DOCUMENTED_BATCH_ACTIONS = [
  { kind: "wait", timeMs: 500 },
  { kind: "click", ref: "12" },
  { kind: "type", ref: "23", text: "hello" },
];

describe("normalizeActRequest batch contract", () => {
  it("accepts the documented batch example through the real /act normalizer", () => {
    const normalized = normalizeActRequest({
      kind: "batch",
      actions: DOCUMENTED_BATCH_ACTIONS,
    });
    expect(normalized).toMatchObject({
      kind: "batch",
      actions: [
        { kind: "wait", timeMs: 500 },
        { kind: "click", ref: "12" },
        { kind: "type", ref: "23", text: "hello" },
      ],
    });
  });

  it("rejects open/navigate/snapshot/screenshot as nested batch actions", () => {
    // These are CLI subcommands, not BrowserActRequest kinds; the route normalizer
    // must reject them so documented examples cannot describe a non-reproducible workflow.
    for (const kind of ["open", "navigate", "snapshot", "screenshot"]) {
      expect(() =>
        normalizeActRequest({
          kind: "batch",
          actions: [{ kind, url: "https://example.com" }],
        }),
      ).toThrow("kind is required");
    }
  });

  it("forwards --continue as stopOnError=false and --target-id on the outer batch", () => {
    const normalized = normalizeActRequest({
      kind: "batch",
      actions: DOCUMENTED_BATCH_ACTIONS,
      targetId: "tab-1",
      stopOnError: false,
    });
    expect(normalized).toMatchObject({
      kind: "batch",
      targetId: "tab-1",
      stopOnError: false,
    });
  });
});
