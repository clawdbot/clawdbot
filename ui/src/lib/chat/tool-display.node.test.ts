// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveEmbedSandbox } from "./tool-display.ts";

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
