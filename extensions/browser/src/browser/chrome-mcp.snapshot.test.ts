import { describe, expect, it } from "vitest";
import {
  buildAiSnapshotFromChromeMcpSnapshot,
  flattenChromeMcpSnapshotToAriaNodes,
} from "./chrome-mcp.snapshot.js";

const snapshot = {
  id: "root",
  role: "document",
  name: "Example",
  children: [
    {
      id: "btn-1",
      role: "button",
      name: "Continue",
    },
    {
      id: "txt-1",
      role: "textbox",
      name: "Email",
      value: "peter@example.com",
    },
  ],
};

describe("chrome MCP snapshot conversion", () => {
  it("flattens structured snapshots into aria-style nodes", () => {
    const nodes = flattenChromeMcpSnapshotToAriaNodes(snapshot, 10);
    expect(nodes).toEqual([
      {
        ref: "root",
        role: "document",
        name: "Example",
        value: undefined,
        description: undefined,
        depth: 0,
      },
      {
        ref: "btn-1",
        role: "button",
        name: "Continue",
        value: undefined,
        description: undefined,
        depth: 1,
      },
      {
        ref: "txt-1",
        role: "textbox",
        name: "Email",
        value: "peter@example.com",
        description: undefined,
        depth: 1,
      },
    ]);
  });

  it("builds AI snapshots that preserve Chrome MCP uids as refs", () => {
    const result = buildAiSnapshotFromChromeMcpSnapshot({ root: snapshot });

    expect(result.snapshot).toContain('- button "Continue" [ref=btn-1]');
    expect(result.snapshot).toContain('- textbox "Email" [ref=txt-1] value="peter@example.com"');
    expect(result.refs).toEqual({
      "btn-1": { role: "button", name: "Continue" },
      "txt-1": { role: "textbox", name: "Email" },
    });
    expect(result.stats.refs).toBe(2);
  });
});
