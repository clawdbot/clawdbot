import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { registerTestWidgetContentKind } from "./widget-tool.content-kinds.test-support.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => resetPluginRuntimeStateForTest());
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
});

describe("show_widget script syntax gate", () => {
  it.each(["inline", "pinned", "current_channel", "node_panel"] as const)(
    "rejects broken scripts before any side effect on %s",
    async (route) => {
      const stateDir = tempDirs.make("openclaw-widget-syntax-");
      const { mock: gateway, callGateway } = createBoardPutCaller();
      const present = vi.fn<WidgetPresenter["present"]>();
      const availability = vi.fn<WidgetPresenter["availability"]>();
      const presenters: WidgetPresenter[] =
        route === "current_channel"
          ? [
              {
                target: "current_channel",
                description: "Test channel",
                capabilities: { sourceKinds: ["html"] },
                match: () => true,
                availability,
                present,
              },
            ]
          : [{ target: "node_panel", description: "Test panel", availability, present }];
      const tool = createShowWidgetTool({
        stateDir,
        sessionId: "syntax",
        agentSessionKey: "agent:main:syntax",
        callGateway,
        presenters,
      });
      const result = tool.execute("broken", {
        title: "Broken widget",
        widget_code: "<p>Widget</p>\n<script>const a='x\n'+b;</script>",
        pin: route === "pinned",
        ...(route === "node_panel" ? { presentation: { target: "node_panel" } } : {}),
      });
      await expect(result).rejects.toThrow(WidgetHtmlInputError);
      await expect(result).rejects.toThrow(
        "widget_code has a JavaScript syntax error in inline script 1 at line 2, column 16: Unterminated string constant. Offending line: <script>const a='x. Fix the script and call show_widget again.",
      );
      expect(gateway).not.toHaveBeenCalled();
      expect(present).not.toHaveBeenCalled();
      expect(availability).not.toHaveBeenCalled();
      await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
    },
  );

  it("leaves registered source validation to the content kind", async () => {
    registerTestWidgetContentKind("diagram", () => "<p>Rendered diagram</p>");
    const stateDir = tempDirs.make("openclaw-widget-syntax-");
    const tool = createShowWidgetTool({ stateDir, sessionId: "registered-syntax" });
    const result = await tool.execute("registered", {
      title: "Diagram",
      kind: "diagram",
      widget_code: "diagram:<script>const =</script>",
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toMatchObject({ kind: "canvas" });
  });

  it("still hosts a valid script as a canvas widget", async () => {
    const stateDir = tempDirs.make("openclaw-widget-syntax-");
    const tool = createShowWidgetTool({ stateDir, sessionId: "valid-syntax" });
    const result = await tool.execute("valid", {
      title: "Working widget",
      widget_code: "<script>document.body.textContent = 'Working';</script>",
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toMatchObject({ kind: "canvas" });
    await expect(access(resolveCanvasDocumentsDir(stateDir))).resolves.toBeUndefined();
  });
});
