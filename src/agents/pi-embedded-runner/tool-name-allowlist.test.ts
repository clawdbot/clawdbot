import { describe, expect, it } from "vitest";
import { createStubTool } from "../test-helpers/pi-tool-stubs.js";
import {
  collectAllowedToolNames,
  collectRegisteredToolNames,
  PI_RESERVED_TOOL_NAMES,
  toSessionToolAllowlist,
} from "./tool-name-allowlist.js";

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

  it("collects exact registered custom-tool names for the Pi session allowlist", () => {
    const allowlist = toSessionToolAllowlist(
      collectRegisteredToolNames([
        { name: "exec" },
        { name: "read" },
        { name: "exec" },
        { name: "image_generate" },
      ]),
    );

    expect(allowlist).toEqual(["exec", "image_generate", "read"]);
  });

  it("pins the reserved Pi built-in tool namespace used by client conflict checks", () => {
    expect(PI_RESERVED_TOOL_NAMES).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("keeps collected run allowlists broader than the Pi session allowlist source", () => {
    const allowlist = toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: [createStubTool("exec"), createStubTool("read"), createStubTool("exec")],
        clientTools: [
          {
            type: "function",
            function: {
              name: "image_generate",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    );

    expect(allowlist).toEqual(["exec", "image_generate", "read"]);
  });
});
