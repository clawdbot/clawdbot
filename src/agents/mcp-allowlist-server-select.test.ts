/** Behavior tests for server-granular MCP allowlist selection. */
import { afterEach, describe, expect, it } from "vitest";
import {
  isMcpServerToolAllowlisted,
  selectAllowlistedStaticMcpServerNames,
} from "./mcp-allowlist-server-select.js";

describe("isMcpServerToolAllowlisted", () => {
  it("includes a server named by the allowlist (or when unrestricted)", () => {
    expect(isMcpServerToolAllowlisted("opik", undefined)).toBe(true);
    expect(isMcpServerToolAllowlisted("opik", ["*"])).toBe(true);
    expect(isMcpServerToolAllowlisted("opik", ["bundle-mcp"])).toBe(true);
    expect(isMcpServerToolAllowlisted("opik", ["group:plugins"])).toBe(true);
    expect(isMcpServerToolAllowlisted("opik", ["opik__*"])).toBe(true);
    expect(isMcpServerToolAllowlisted("opik", ["opik__list"])).toBe(true);
    // Normalization: surrounding space and server-prefix case are ignored.
    expect(isMcpServerToolAllowlisted("opik", [" Opik__list "])).toBe(true);
  });

  it("excludes a server the allowlist does not reference", () => {
    expect(isMcpServerToolAllowlisted("opik", ["notion__*"])).toBe(false);
    expect(isMcpServerToolAllowlisted("opik", ["message"])).toBe(false);
    // A bare `<server>__` with no tool fragment does not reference the server.
    expect(isMcpServerToolAllowlisted("opik", ["opik__"])).toBe(false);
    // An empty allowlist restricts to nothing.
    expect(isMcpServerToolAllowlisted("opik", [])).toBe(false);
  });
});

describe("selectAllowlistedStaticMcpServerNames", () => {
  afterEach(async () => {
    const { testing } = await import("./mcp-connection-resolver.js");
    testing.setMcpServerConnectionResolversForTest();
  });

  const cfg = {
    mcp: { servers: { opik: { command: "true" }, notion: { command: "true" } } },
  };

  it("selects only static servers the scoped allowlist references", () => {
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow: ["opik__read"],
    });
    expect(selected.has("opik")).toBe(true);
    expect(selected.has("notion")).toBe(false);
  });

  it("selects every static server referenced by a multi-token allowlist", () => {
    // A merged allow + alsoAllow list is just more tokens: each server the list
    // names is selected. Deny is not a server-selection input — a denied tool on
    // an allowed server still opens the server; the tool is dropped downstream by
    // the harness tool policy, not here.
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow: ["opik__read", "notion__list"],
    });
    expect([...selected].toSorted()).toEqual(["notion", "opik"]);
  });

  it("returns an empty set when the allowlist imposes no restriction", () => {
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow: undefined,
    });
    expect(selected.size).toBe(0);
  });

  it("excludes a requester-scoped server even when the allowlist names it", async () => {
    const { testing } = await import("./mcp-connection-resolver.js");
    // A registered resolver makes opik requester-scoped; it must not be selected
    // as a static server (it resolves on its own path, not the static harness).
    testing.setMcpServerConnectionResolversForTest([
      { serverName: "opik", resolve: async () => ({ url: "https://mcp.example.test" }) },
    ]);
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow: ["opik__read", "notion__read"],
    });
    expect(selected.has("opik")).toBe(false);
    expect(selected.has("notion")).toBe(true);
  });
});
