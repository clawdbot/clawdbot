import { describe, expect, it } from "vitest";
import { createStubTool } from "../test-helpers/pi-tool-stubs.js";
import { collectAllowedToolNames, toSessionToolAllowlist } from "./tool-name-allowlist.js";

describe("tool name allowlists", () => {
  it("collects local and client tool names", () => {
    const names = collectAllowedToolNames({
      tools: [createStubTool("read"), createStubTool("memory_search")],
      clientTools: [
        {
          type: "function",
          function: {
            name: "image_generate",
            description: "Generate an image",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    expect([...names]).toEqual(["read", "memory_search", "image_generate"]);
  });

  it("builds a stable Pi session allowlist from custom tool names", () => {
    const allowlist = toSessionToolAllowlist(new Set(["write", "read", "read", "edit"]));

    expect(allowlist).toEqual(["edit", "read", "write"]);
  });
});
