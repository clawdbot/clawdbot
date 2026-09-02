import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";

beforeEach(() => resetPluginRuntimeStateForTest());
afterEach(() => resetPluginRuntimeStateForTest());

describe("show_widget capability outcomes", () => {
  it.each(["pending", "rejected", "granted"] as const)(
    "reports the owner's %s capability outcome",
    async (grantState) => {
      const { mock, callGateway } = createBoardPutCaller();
      const original = mock.getMockImplementation()!;
      mock.mockImplementation(async (...args) => {
        const snapshot = await original(...args);
        snapshot.widgets[0]!.grantState = grantState;
        return snapshot;
      });
      const tool = createShowWidgetTool({
        agentSessionKey: "agent:main:approval",
        inlineHostEnabled: false,
        callGateway,
      });
      const result = await tool.execute("pin", {
        title: "Runs",
        widget_code: "<p>runs</p>",
        pin: true,
        capabilities: { tools: ["github.actions.runs:owner/repo"] },
      });
      const text = result.content.find((item) => item.type === "text")?.text;
      if (!text) {
        throw new Error("expected widget tool text result");
      }
      const payload = JSON.parse(text);
      expect(payload).toMatchObject({ boardWidgetName: "runs", capabilityState: grantState });
      expect(payload.text).toContain(grantState);
      if (grantState !== "granted") {
        expect(payload.text).toMatch(/approve|review/i);
      }
    },
  );
});
