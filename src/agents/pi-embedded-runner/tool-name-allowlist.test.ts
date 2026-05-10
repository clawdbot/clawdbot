import { describe, expect, it } from "vitest";
import { findClientToolNameConflicts } from "../pi-tool-definition-adapter.js";
import { createStubTool } from "../test-helpers/pi-tool-stubs.js";
import {
  addClientToolsToToolSearchCatalog,
  applyToolSearchCatalog,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "../tool-search.js";
import type { ClientToolDefinition } from "./run/params.js";
import {
  collectAllowedToolNames,
  collectCoreBuiltinToolNames,
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

  it("keeps hidden core names available for client conflict admission", () => {
    const uncompactedTools = [
      createStubTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME),
      createStubTool("exec"),
      createStubTool("message"),
    ];
    const compacted = applyToolSearchCatalog({
      tools: uncompactedTools,
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-conflict-admission",
    });
    const names = collectCoreBuiltinToolNames(uncompactedTools);

    expect([...names]).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME, "exec", "message"]);
    expect(compacted.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
    expect(
      findClientToolNameConflicts({
        tools: [
          {
            type: "function",
            function: {
              name: "exec",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        existingToolNames: [...names, ...PI_RESERVED_TOOL_NAMES],
      }),
    ).toEqual(["exec"]);
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

  it("excludes client tool names when Tool Search compacts them into the catalog", () => {
    const config = { tools: { toolSearch: true } } as never;
    const compacted = applyToolSearchCatalog({
      tools: [createStubTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME)],
      config,
      sessionId: "session-client-allowed-names",
    });
    const clientTools: ClientToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "client_pick_file",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const clientToolSearch = addClientToolsToToolSearchCatalog({
      tools: [createStubTool("client_pick_file")],
      config,
      sessionId: "session-client-allowed-names",
    });

    const allowlist = toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: compacted.tools,
        clientTools: compacted.catalogRegistered ? undefined : clientTools,
      }),
    );

    expect(compacted.catalogRegistered).toBe(true);
    expect(clientToolSearch.tools).toEqual([]);
    expect(allowlist).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
  });

  it("keeps hidden catalog tools valid for replay guards after Tool Search compaction", () => {
    const config = { tools: { toolSearch: true } } as never;
    const uncompactedTools = [
      createStubTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME),
      createStubTool("exec"),
      createStubTool("fake_plugin_tool"),
    ];
    const compacted = applyToolSearchCatalog({
      tools: uncompactedTools,
      config,
      sessionId: "session-replay-allowed-names",
    });
    const clientTools: ClientToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "client_pick_file",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const visibleAllowlist = toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: compacted.tools,
        clientTools: compacted.catalogRegistered ? undefined : clientTools,
      }),
    );
    const replayAllowlist = toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: uncompactedTools,
        clientTools,
      }),
    );

    expect(visibleAllowlist).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
    expect(replayAllowlist).toEqual([
      "client_pick_file",
      "exec",
      "fake_plugin_tool",
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
    ]);
  });
});
