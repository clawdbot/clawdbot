import { describe, expect, it } from "vitest";
import {
  getPluginWidgetKindContribution,
  loadPluginWidgetRenderer,
  pluginIdForWidgetKind,
  type PluginBoardWidgetRenderer,
} from "./index.ts";

describe("plugin board widget registry", () => {
  it("resolves built-in kinds only when their owner advertises them", () => {
    const active = [
      { pluginId: "session", kind: "session:progress", label: "Progress" },
      { pluginId: "workboard", kind: "workboard:board", label: "Workboard board" },
    ];
    expect(getPluginWidgetKindContribution("session:progress", active)).toMatchObject({
      kind: "session:progress",
      loader: expect.any(Function),
    });
    expect(getPluginWidgetKindContribution("session:progress", [])).toBeNull();
    expect(
      getPluginWidgetKindContribution("session:progress", [
        { pluginId: "other", kind: "session:progress", label: "Progress" },
      ]),
    ).toBeNull();
    expect(getPluginWidgetKindContribution("workboard:board", active)).toBeNull();
    expect(getPluginWidgetKindContribution("unknown:card", active)).toBeNull();
    expect(pluginIdForWidgetKind("workboard:card")).toBe("workboard");
  });

  it("retries a renderer whose lazy import failed", async () => {
    const renderer: PluginBoardWidgetRenderer = () => ({}) as never;
    await expect(
      loadPluginWidgetRenderer({
        kind: "test:retry",
        label: "Retry",
        loader: async () => await Promise.reject(new Error("chunk unavailable")),
      }),
    ).rejects.toThrow("chunk unavailable");

    await expect(
      loadPluginWidgetRenderer({
        kind: "test:retry",
        label: "Retry",
        loader: async () => renderer,
      }),
    ).resolves.toBe(renderer);
  });
});
