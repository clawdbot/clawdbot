import { describe, expect, it } from "vitest";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "./tool-allowlist-guard.js";

describe("tool allowlist guard", () => {
  it("fails closed when explicit allowlists resolve to no callable tools", () => {
    const error = buildEmptyExplicitToolAllowlistError({
      sources: [{ label: "tools.allow", entries: [" query_db "] }],
      callableToolNames: [],
      toolsEnabled: true,
    });

    expect(error?.message).toContain("No callable tools remain");
    expect(error?.message).toContain("tools.allow: query_db");
    expect(error?.message).toContain("no registered tools matched");
  });

  it("fails closed for runtime toolsAllow when tools are disabled", () => {
    const error = buildEmptyExplicitToolAllowlistError({
      sources: [{ label: "runtime toolsAllow", entries: ["query_db"] }],
      callableToolNames: [],
      toolsEnabled: true,
      disableTools: true,
    });

    expect(error?.message).toContain("runtime toolsAllow: query_db");
    expect(error?.message).toContain("tools are disabled for this run");
  });

  it("fails closed when the selected model cannot use requested tools", () => {
    const error = buildEmptyExplicitToolAllowlistError({
      sources: [{ label: "agents.db.tools.allow", entries: ["query_db"] }],
      callableToolNames: [],
      toolsEnabled: false,
    });

    expect(error?.message).toContain("agents.db.tools.allow: query_db");
    expect(error?.message).toContain("the selected model does not support tools");
  });

  it("allows text-only runs without explicit allowlists", () => {
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [],
        callableToolNames: [],
        toolsEnabled: true,
      }),
    ).toBeNull();
  });

  it("allows explicit allowlists when at least one callable tool remains", () => {
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [{ label: "tools.allow", entries: ["read", "missing_tool"] }],
        callableToolNames: ["read"],
        toolsEnabled: true,
      }),
    ).toBeNull();
  });

  it("keeps source labels for config and runtime allowlists", () => {
    const sources = collectExplicitToolAllowlistSources([
      { label: "tools.allow", allow: [" read ", ""] },
      { label: "runtime toolsAllow", allow: ["query_db"] },
      { label: "tools.byProvider.allow" },
    ]);

    expect(sources).toEqual([
      { label: "tools.allow", entries: ["read"] },
      { label: "runtime toolsAllow", entries: ["query_db"] },
    ]);
  });
});
