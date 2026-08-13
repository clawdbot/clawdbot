import { describe, expect, it } from "vitest";
import {
  getPluginWidgetKindContribution,
  loadPluginWidgetRenderer,
  pluginIdForWidgetKind,
  type PluginBoardWidgetRenderer,
} from "./index.ts";

describe("plugin board widget registry", () => {
  it("resolves only advertised first-party kinds", () => {
    const active = [{ pluginId: "workboard", kind: "workboard:card", label: "Workboard card" }];
    expect(getPluginWidgetKindContribution("workboard:card", active)).toMatchObject({
      kind: "workboard:card",
      label: "Workboard card",
      loader: expect.any(Function),
    });
    expect(getPluginWidgetKindContribution("workboard:mini", active)).toBeNull();
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
