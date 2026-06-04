// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch", () => {
  function makeAgentListBaseAndPatch() {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", memorySearch: { extraPaths: ["/tmp/memory.md"] } }],
      },
    };
    return { base, patch };
  }

  it("replaces arrays by default", () => {
    const { base, patch } = makeAgentListBaseAndPatch();

    const merged = applyMergePatch(base, patch) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };
    expect(merged.agents?.list).toEqual([
      { id: "primary", memorySearch: { extraPaths: ["/tmp/memory.md"] } },
    ]);
  });

  it("merges object arrays by id when enabled", () => {
    const { base, patch } = makeAgentListBaseAndPatch();

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{
          id?: string;
          workspace?: string;
          memorySearch?: { extraPaths?: string[] };
        }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(2);
    const primary = merged.agents?.list?.find((entry) => entry.id === "primary");
    const secondary = merged.agents?.list?.find((entry) => entry.id === "secondary");
    expect(primary?.workspace).toBe("/tmp/one");
    expect(primary?.memorySearch?.extraPaths).toEqual(["/tmp/memory.md"]);
    expect(secondary?.workspace).toBe("/tmp/two");
  });

  it("merges by id even when patch entries lack id (appends them)", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", model: "new-model" }, { workspace: "/tmp/orphan" }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string; model?: string }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(3);
    const primary = merged.agents?.list?.find((entry) => entry.id === "primary");
    expect(primary?.workspace).toBe("/tmp/one");
    expect(primary?.model).toBe("new-model");
    expect(merged.agents?.list?.[1]?.id).toBe("secondary");
    expect(merged.agents?.list?.[2]?.workspace).toBe("/tmp/orphan");
  });

  it("does not destroy agents list when patching a single agent by id", () => {
    const base = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/home/main" },
          { id: "ota", workspace: "/home/ota" },
          { id: "trading", workspace: "/home/trading" },
          { id: "codex", workspace: "/home/codex" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "main", model: "claude-opus-4-20250918" }],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string; model?: string; default?: boolean }>;
      };
    };
    expect(merged.agents?.list).toHaveLength(4);
    const main = merged.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.model).toBe("claude-opus-4-20250918");
    expect(main?.default).toBe(true);
    expect(main?.workspace).toBe("/home/main");
    expect(merged.agents?.list?.find((entry) => entry.id === "ota")?.workspace).toBe("/home/ota");
    expect(merged.agents?.list?.find((entry) => entry.id === "trading")?.workspace).toBe(
      "/home/trading",
    );
    expect(merged.agents?.list?.find((entry) => entry.id === "codex")?.workspace).toBe(
      "/home/codex",
    );
  });

  it("keeps existing id entries when patch mixes id and primitive entries", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one" },
          { id: "secondary", workspace: "/tmp/two" },
        ],
      },
    };
    const patch = {
      agents: {
        list: [{ id: "primary", workspace: "/tmp/one-updated" }, "non-object entry"],
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      agents?: {
        list?: Array<{ id?: string; workspace?: string } | string>;
      };
    };

    expect(merged.agents?.list).toHaveLength(3);
    const primary = merged.agents?.list?.find(
      (entry): entry is { id?: string; workspace?: string } =>
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === "primary",
    );
    const secondary = merged.agents?.list?.find(
      (entry): entry is { id?: string; workspace?: string } =>
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === "secondary",
    );
    expect(primary?.workspace).toBe("/tmp/one-updated");
    expect(secondary?.workspace).toBe("/tmp/two");
    expect(merged.agents?.list?.[2]).toBe("non-object entry");
  });

  it("falls back to replacement for non-id arrays even when enabled", () => {
    const base = {
      channels: {
        telegram: { allowFrom: ["111", "222"] },
      },
    };
    const patch = {
      channels: {
        telegram: { allowFrom: ["333"] },
      },
    };

    const merged = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as {
      channels?: {
        telegram?: { allowFrom?: string[] };
      };
    };
    expect(merged.channels?.telegram?.allowFrom).toEqual(["333"]);
  });
});
