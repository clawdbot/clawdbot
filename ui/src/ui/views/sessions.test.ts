/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildMultiResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    basePath: "",
    searchQuery: "",
    sortColumn: "updated",
    sortDir: "desc",
    page: 0,
    pageSize: 10,
    selectedKeys: new Set<string>(),
    expandedCheckpointKey: null,
    checkpointItemsByKey: {},
    checkpointLoadingKey: null,
    checkpointBusyKey: null,
    checkpointErrorByKey: {},
    onFiltersChange: () => undefined,
    onSearchChange: () => undefined,
    onSortChange: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
    onToggleCheckpointDetails: () => undefined,
    onBranchFromCheckpoint: () => undefined,
    onRestoreCheckpoint: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders and patches provider-owned thinking ids", async () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingLevel: "adaptive",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "adaptive", label: "adaptive" },
              { id: "max", label: "maximum" },
            ],
          }),
        ),
        onPatch,
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("adaptive");
    expect(Array.from(thinking?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "adaptive",
      "max",
    ]);
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "max")
        ?.textContent?.trim(),
    ).toBe("maximum");

    thinking!.value = "max";
    thinking!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: "max" });
  });

  it("labels inherited thinking with the resolved session default", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingDefault: "adaptive",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "adaptive", label: "adaptive" },
            ],
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("");
    expect(thinking?.options[0]?.textContent?.trim()).toBe("Default (adaptive)");
  });

  it("keeps legacy binary thinking labels patching canonical ids", async () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            thinkingLevel: "low",
            thinkingOptions: ["off", "on"],
          }),
        ),
        onPatch,
      }),
      container,
    );
    await Promise.resolve();

    const thinking = container.querySelector("tbody select") as HTMLSelectElement | null;
    expect(thinking?.value).toBe("low");
    expect(
      Array.from(thinking?.options ?? [])
        .find((option) => option.value === "low")
        ?.textContent?.trim(),
    ).toBe("on");

    thinking!.value = "low";
    thinking!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith("agent:main:main", { thinkingLevel: "low" });
  });

  it("keeps session selects stable and deselects only the current page", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            fastMode: true,
            verboseLevel: "full",
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const fast = selects[1] as HTMLSelectElement | undefined;
    const verbose = selects[2] as HTMLSelectElement | undefined;
    const reasoning = selects[3] as HTMLSelectElement | undefined;
    expect(fast?.value).toBe("on");
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);

    const onSelectPage = vi.fn();
    const onDeselectPage = vi.fn();
    const onDeselectAll = vi.fn();
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "page-0",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "page-1",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
        pageSize: 1,
        selectedKeys: new Set(["page-0", "off-page"]),
        onSelectPage,
        onDeselectPage,
        onDeselectAll,
      }),
      container,
    );
    await Promise.resolve();

    const headerCheckbox = container.querySelector("thead input[type=checkbox]");
    headerCheckbox?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onDeselectPage).toHaveBeenCalledWith(["page-0"]);
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onSelectPage).not.toHaveBeenCalled();
  });
});
