import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { resolveAuthorizedBoardWidgetView } from "../board-widget-view.js";
import { createBoardHarness } from "./board.test-support.js";

function registeredWidgetRegistry() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "diagram",
    source: "diagram-fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  const validateSource = vi.fn((source: string) => {
    if (!source.startsWith("diagram:")) {
      throw new Error("diagram prefix required");
    }
  });
  const composeDocument = vi.fn(
    ({
      source,
      resourceUrls,
    }: {
      source: string;
      resourceUrls: Readonly<Record<string, string>>;
    }) =>
      `<main>${source}</main><script src="${resourceUrls["/__openclaw__/diagram/app.js"]}"></script>`,
  );
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind: "diagram",
    label: "Diagram",
    resources: {
      surface: "diagram",
      paths: ["/__openclaw__/diagram/app.js"],
    },
    validateSource,
    composeDocument,
  });
  registry.plugins.push(record);
  return { registry, validateSource, composeDocument };
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("board registered widget content kinds", () => {
  it("validates, persists, composes, and updates registered source by name", async () => {
    const previous = getActivePluginRegistry();
    const { registry, validateSource, composeDocument } = registeredWidgetRegistry();
    setActivePluginRegistry(registry);
    const { invoke, store } = createBoardHarness(
      undefined,
      {},
      undefined,
      {},
      {
        connect: {} as never,
        pluginSurfaceUrls: {
          diagram: "https://gateway.test/__openclaw__/cap/diagram-token",
        },
      },
    );
    try {
      await invoke("board.widget.put", {
        sessionKey: "session",
        name: "status",
        content: { kind: "registered", contentKind: "diagram", source: "diagram:first" },
      });
      const updated = await invoke("board.widget.put", {
        sessionKey: "session",
        name: "status",
        content: { kind: "registered", contentKind: "diagram", source: "diagram:second" },
      });

      expect(validateSource).toHaveBeenCalledTimes(2);
      expect(updated.mock.calls[0]?.[1]).toMatchObject({
        widgets: [
          {
            name: "status",
            contentKind: "plugin",
            contentOwner: "registered",
            registeredContentKind: "diagram",
            pluginKind: "diagram:diagram",
            revision: 2,
          },
        ],
      });
      expect(store.readWidgetRegistered("session", "status")).toMatchObject({
        source: "diagram:second",
        pluginKind: "diagram:diagram",
        revision: 2,
      });

      const board = await invoke("board.get", { sessionKey: "session" });
      const snapshot = board.mock.calls[0]?.[1];
      if (!snapshot) {
        throw new Error("board.get did not return a snapshot");
      }
      const widget = (snapshot as BoardSnapshot).widgets[0]!;
      expect(widget).toMatchObject({
        contentOwner: "registered",
        registeredContentKind: "diagram",
        kindLabel: "Diagram",
        frameUrl: expect.stringContaining("/__openclaw__/board/"),
        sandboxUrl: expect.stringContaining("/mcp-app-sandbox"),
      });
      const authorized = resolveAuthorizedBoardWidgetView(store, widget.viewTicket!);
      expect(authorized.document.html).toContain("<main>diagram:second</main>");
      expect(authorized.document.html).toContain(
        "https://gateway.test/__openclaw__/cap/diagram-token/__openclaw__/diagram/app.js",
      );
      expect(composeDocument).toHaveBeenCalledOnce();
    } finally {
      if (previous) {
        setActivePluginRegistry(previous);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });

  it("returns an actionable error when the providing plugin is unavailable", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const { invoke } = createBoardHarness();

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "status",
      content: { kind: "registered", contentKind: "diagram", source: "diagram:first" },
    });

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]?.message).toContain(
      'widget kind "diagram" is unavailable; enable the plugin that provides it and retry',
    );
  });

  it.each(["ask", "full"] as const)(
    "composes registered widget prompt actions after the %s policy grant",
    async (mode) => {
      const { registry, composeDocument } = registeredWidgetRegistry();
      setActivePluginRegistry(registry);
      const { invoke, store } = createBoardHarness(
        undefined,
        {},
        undefined,
        {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: "main" }] },
            tools: { exec: { mode } },
          }),
        },
        {
          connect: {} as never,
          pluginSurfaceUrls: {
            diagram: "https://gateway.test/__openclaw__/cap/diagram-token",
          },
        },
      );
      const put = await invoke("board.widget.put", {
        sessionKey: "session",
        name: "prompting",
        content: { kind: "registered", contentKind: "diagram", source: "diagram:prompt" },
        declared: { tools: ["prompt"] },
      });
      const putSnapshot = put.mock.calls[0]?.[1];
      if (!putSnapshot) {
        throw new Error("board.widget.put did not return a snapshot");
      }
      const widgetSnapshot = (putSnapshot as BoardSnapshot).widgets[0]!;
      expect(widgetSnapshot.grantState).toBe(mode === "ask" ? "pending" : "granted");
      if (mode === "ask") {
        await invoke("board.widget.grant", {
          sessionKey: "session",
          name: "prompting",
          decision: "granted",
          revision: widgetSnapshot.revision,
          instanceId: widgetSnapshot.instanceId,
        });
      }
      const board = await invoke("board.get", { sessionKey: "session" });
      const snapshot = board.mock.calls[0]?.[1];
      if (!snapshot) {
        throw new Error("board.get did not return a snapshot");
      }
      const widget = (snapshot as BoardSnapshot).widgets[0]!;

      resolveAuthorizedBoardWidgetView(store, widget.viewTicket!);

      expect(composeDocument).toHaveBeenCalledWith(
        expect.objectContaining({ promptGranted: true }),
      );
    },
  );
});
