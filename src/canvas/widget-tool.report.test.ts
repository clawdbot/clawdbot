import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDashboardTool } from "../agents/tools/dashboard-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import type { BoardReport } from "../boards/board-report.js";
import { createTestBoardStore } from "../boards/board-store.test-support.js";
import { createBoardHarness } from "../gateway/server-methods/board.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { registerTestWidgetContentKind } from "./widget-tool.content-kinds.test-support.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
});

const report: BoardReport = {
  blocks: [
    { type: "text", title: "Community pulse", text: "Activity is steady." },
    { type: "metrics", items: [{ label: "Authors", value: "312", detail: "This week" }] },
    { type: "table", columns: ["Topic", "Threads"], rows: [["Support", "160"]] },
    { type: "chart", style: "line", points: [{ label: "Mon", value: 12 }] },
    { type: "links", items: [{ label: "Details", url: "https://example.com/details" }] },
  ],
};

describe("native report authoring", () => {
  it("fails a registered renderer before writing a pinned widget", async () => {
    registerTestWidgetContentKind("diagram", () => {
      throw new Error("Renderer unavailable");
    });
    const callGateway = vi.fn();
    const tool = createShowWidgetTool({ agentSessionKey: "agent:main:report", callGateway });
    await expect(
      tool.execute("renderer-failed", {
        title: "Diagram",
        kind: "diagram",
        pin: true,
        widget_code: "diagram:ready",
      }),
    ).rejects.toThrow("Renderer unavailable");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves plugin source kinds named report alongside native report data", async () => {
    registerTestWidgetContentKind("report");
    const { mock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      stateDir: tempDirs.make("openclaw-report-plugin-"),
      agentSessionKey: "agent:main:report-plugin",
      callGateway,
    });
    const result = await tool.execute("registered-report", {
      title: "Plugin report",
      kind: "report",
      widget_code: "diagram:ready",
      pin: true,
    });
    expect(result.details).toMatchObject({ kind: "canvas", view: { id: expect.any(String) } });
    expect(mock).toHaveBeenCalledWith(
      "board.widget.put",
      expect.objectContaining({
        content: { kind: "registered", contentKind: "report", source: "diagram:ready" },
      }),
    );
  });

  it.each([
    { sessionKey: "agent:main:dashboard:report", agentId: "main" },
    { sessionKey: "global", agentId: "research" },
  ])(
    "pins, updates and reopens a report for $agentId/$sessionKey without a document",
    async (target) => {
      const stateDir = tempDirs.make("openclaw-native-report-");
      const store = createTestBoardStore({ stateDir });
      const sibling = {
        sessionKey: "global",
        agentId: target.agentId === "main" ? "research" : "main",
      };
      const siblingBefore = store.getSnapshot(sibling);
      const { invoke } = createBoardHarness(undefined, {}, store, {
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, research: {} } },
        }),
      });
      const callGateway: InProcessGatewayCaller = async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        const response = await invoke(method, params);
        const [ok, payload, error] = response.mock.calls[0]!;
        if (!ok) {
          throw new Error(error?.message ?? "Report request failed");
        }
        return payload as T;
      };
      const tool = createShowWidgetTool({
        stateDir,
        agentSessionKey: target.sessionKey,
        agentId: target.agentId,
        callGateway,
      });
      const result = await tool.execute("create-report", {
        title: "Community pulse",
        name: "community-pulse",
        pin: true,
        report,
      });
      expect(result.details).toMatchObject({
        status: "pinned",
        boardWidgetName: "community-pulse",
      });
      expect(store.getSnapshot(target).widgets[0]).toMatchObject({
        name: "community-pulse",
        contentKind: "plugin",
        contentOwner: "plugin",
        pluginKind: "session:report",
        props: report,
        grantState: "none",
        revision: 1,
      });
      const updated = { blocks: [{ type: "text", text: "Refreshed from the agent." }] };
      await createDashboardTool({
        agentSessionKey: target.sessionKey,
        agentId: target.agentId,
        callGateway,
      }).execute("update-report", {
        action: "widget_put",
        name: "community-pulse",
        pluginKind: "session:report",
        props: updated,
      });
      closeOpenClawAgentDatabasesForTest();
      expect(store.getSnapshot(target).widgets[0]).toMatchObject({ props: updated, revision: 2 });
      const view = await invoke("board.get", target);
      expect(view.mock.calls[0]?.[0]).toBe(true);
      const snapshot = view.mock.calls[0]?.[1] as { widgets: Array<Record<string, unknown>> };
      expect(snapshot.widgets[0]).toMatchObject({ pluginKind: "session:report", props: updated });
      expect(snapshot.widgets[0]).not.toHaveProperty("frameUrl");
      expect(snapshot.widgets[0]).not.toHaveProperty("viewTicket");
      expect(store.readWidgetHtml(target, "community-pulse")).toBeUndefined();
      expect(store.getSnapshot(sibling)).toEqual(siblingBefore);
      await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
    },
  );

  it.each([
    {
      label: "executable fields",
      props: { blocks: [{ type: "text", text: "Hello", script: "ignored" }] },
    },
    {
      label: "unsupported blocks",
      props: { blocks: [{ type: "image", url: "https://example.com/image.png" }] },
    },
    {
      label: "script links",
      props: {
        blocks: [{ type: "links", items: [{ label: "Invalid", url: "javascript:void(0)" }] }],
      },
    },
    {
      label: "mismatched table rows",
      props: { blocks: [{ type: "table", columns: ["A", "B"], rows: [["one"]] }] },
    },
    {
      label: "too many points",
      props: {
        blocks: [
          { type: "chart", points: Array.from({ length: 41 }, () => ({ label: "A", value: 1 })) },
        ],
      },
    },
    {
      label: "oversized UTF-8 data",
      props: {
        blocks: Array.from({ length: 3 }, () => ({ type: "text", text: "é".repeat(2_000) })),
      },
    },
  ])("rejects $label at the storage owner without changing the saved report", ({ props }) => {
    const store = createTestBoardStore();
    const target = { sessionKey: "agent:main:report" };
    const content = { kind: "plugin" as const, pluginKind: "session:report", props: report };
    store.putWidget({ ...target, name: "report", content });
    const before = store.getSnapshot(target);
    expect(() =>
      store.putWidget({ ...target, name: "report", content: { ...content, props } }),
    ).toThrow();
    expect(store.getSnapshot(target)).toEqual(before);
  });

  it.each([
    { pin: false },
    { pin: true, capabilities: { tools: ["prompt"] } },
    { pin: true, kind: "html" },
    { pin: true, widget_code: "<p>Other content</p>" },
    { pin: true, presentation: { target: "assistant_message" } },
    { pin: true, presentation: { target: "node_panel" } },
  ])("rejects unsupported report presentation before any write: %j", async (options) => {
    const callGateway = vi.fn();
    const tool = createShowWidgetTool({ agentSessionKey: "agent:main:report", callGateway });
    await expect(
      tool.execute("invalid-report", {
        title: "Report",
        report,
        ...options,
      }),
    ).rejects.toThrow("Reports require pin=true");
    expect(callGateway).not.toHaveBeenCalled();
  });
});
