import { describe, expect, it } from "vitest";
import type { BoardWidget } from "../types.ts";
import {
  getPluginWidgetKindContribution,
  isPassiveBoardWidget,
  pluginIdForWidgetKind,
} from "./index.ts";

describe("plugin board widget registry", () => {
  it("resolves built-in kinds only when their owner advertises them", () => {
    const active = [
      { pluginId: "session", kind: "session:progress", label: "Progress" },
      { pluginId: "session", kind: "session:report", label: "Report" },
      { pluginId: "workboard", kind: "workboard:board", label: "Workboard board" },
    ];
    expect(getPluginWidgetKindContribution("session:progress", active)).toMatchObject({
      kind: "session:progress",
      tagName: "openclaw-session-progress-widget",
      loadModule: expect.any(Function),
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
    expect(getPluginWidgetKindContribution("session:report", active)).toMatchObject({
      tagName: "openclaw-report-widget",
      previewSafe: true,
    });
  });

  it("limits passive previews to advertised pure core widgets and saved HTML", () => {
    const widget: BoardWidget = {
      name: "report",
      tabId: "main",
      contentKind: "plugin",
      pluginKind: "session:report",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const active = [{ pluginId: "session", kind: "session:report", label: "Report" }];
    expect(isPassiveBoardWidget(widget, active)).toBe(true);
    expect(isPassiveBoardWidget(widget, [])).toBe(false);
    expect(isPassiveBoardWidget({ ...widget, frameUrl: "/widget.html" }, active)).toBe(false);
    for (const kind of ["session:progress", "custom:report"]) {
      expect(
        isPassiveBoardWidget({ ...widget, pluginKind: kind }, [
          { pluginId: kind.split(":")[0]!, kind, label: "Widget" },
        ]),
      ).toBe(false);
    }
    expect(isPassiveBoardWidget({ ...widget, contentKind: "mcp-app" }, active)).toBe(false);
    expect(isPassiveBoardWidget({ ...widget, contentKind: "html" }, [])).toBe(true);
  });
});
