import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { DATA_READ_RPC_ALLOWLIST } from "./binding-contract.js";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import { validateWorkspaceDoc } from "./schema.js";

function mainTab() {
  return expectDefined(DEFAULT_WORKSPACE.tabs[0], "default main workspace tab");
}

describe("default Workspaces document", () => {
  it("passes write-time schema validation (seeds cleanly on fresh state)", () => {
    expect(() => validateWorkspaceDoc(DEFAULT_WORKSPACE)).not.toThrow();
  });

  it("ships a single curated system Overview tab", () => {
    expect(DEFAULT_WORKSPACE.tabs).toHaveLength(1);
    const main = mainTab();
    expect(main.slug).toBe("main");
    expect(main.createdBy).toBe("system");
    expect(DEFAULT_WORKSPACE.prefs.tabOrder).toEqual(["main"]);
  });

  it("matches the spec layout (usage cards + instances, sessions + cron, activity)", () => {
    const kinds = mainTab().widgets.map((w) => w.kind);
    expect(kinds).toEqual([
      "builtin:stat-card",
      "builtin:stat-card",
      "builtin:instances",
      "builtin:sessions",
      "builtin:cron",
      "builtin:activity",
    ]);
    // Activity spans the full width, taller (row 3).
    const activity = mainTab().widgets.find((w) => w.id === "activity");
    expect(activity?.grid).toMatchObject({ x: 0, w: 12 });
  });

  it("scopes the Today cards to one calendar day", () => {
    const widgets = mainTab().widgets;
    for (const id of ["cost-today", "tokens-today"]) {
      expect(widgets.find((widget) => widget.id === id)?.bindings?.value).toEqual({
        source: "rpc",
        method: "usage.cost",
        params: { days: 1, agentScope: "all" },
      });
    }
  });

  it("binds only allowlisted rpc methods", () => {
    for (const tab of DEFAULT_WORKSPACE.tabs) {
      for (const widget of tab.widgets) {
        for (const binding of Object.values(widget.bindings ?? {})) {
          if (binding.source === "rpc") {
            expect(DATA_READ_RPC_ALLOWLIST).toContain(binding.method);
          }
        }
      }
    }
  });
});
