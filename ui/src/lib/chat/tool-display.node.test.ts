// @vitest-environment node

import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveEmbedSandbox, resolveToolDisplay } from "./tool-display.ts";

describe("tool display", () => {
  it.each([
    {
      name: "trimmed action with a false first detail",
      params: {
        name: "browser",
        args: { action: " dialog ", accept: false, promptText: "not selected" },
      },
      verb: "dialog",
      detail: "with false",
    },
    {
      name: "redacted unknown-tool fallback",
      params: { name: "unknown_tool", args: { path: "AKIDABCDEFGHIJKLMNOP1234567890" } },
      verb: "unknown tool",
      detail: "with AKIDAB…7890",
    },
    {
      name: "raw command detail",
      params: {
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
        detailMode: "raw",
      },
      verb: "exec",
      detail: "with install dependencies (in ~/my-project), `cd ~/my-project && npm install`",
    },
    {
      name: "explained command detail",
      params: {
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
        detailMode: "explain",
      },
      verb: "exec",
      detail: "with install dependencies (in ~/my-project)",
    },
  ] as const)("preserves $name", ({ params, verb, detail }) => {
    const display = resolveToolDisplay(params);
    expect(display.verb).toBe(verb);
    expect(formatToolDetail(display)).toBe(detail);
  });
});

describe("resolveEmbedSandbox", () => {
  it("caps a trusted global sandbox at scripts-only for isolated previews", () => {
    expect(resolveEmbedSandbox("trusted", "scripts")).toBe("allow-scripts");
    expect(resolveEmbedSandbox("scripts", "scripts")).toBe("allow-scripts");
    expect(resolveEmbedSandbox("strict", "scripts")).toBe("");
  });

  it("preserves existing behavior when a preview has no sandbox ceiling", () => {
    expect(resolveEmbedSandbox("trusted")).toBe("allow-scripts allow-same-origin");
  });
});
