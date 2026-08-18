import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCanvasWidgetPresenter } from "./widget-presenter.js";

const commands = ["canvas.present", "canvas.navigate"];

function createNodesRuntime(
  nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
): PluginRuntime["nodes"] {
  return {
    list: vi.fn(async () => ({ nodes })),
    invoke: vi.fn(async () => ({ ok: true })),
  };
}

describe("Canvas widget presenter", () => {
  it("prefers the existing local Mac default and invokes present before navigate", async () => {
    const runtime = createNodesRuntime([
      {
        nodeId: "android-recent",
        displayName: "Android",
        platform: "android",
        connected: true,
        connectedAtMs: 20,
        caps: ["canvas"],
        invocableCommands: commands,
      },
      {
        nodeId: "mac-local",
        displayName: "Studio",
        platform: "macos",
        connected: true,
        connectedAtMs: 10,
        caps: ["canvas"],
        invocableCommands: commands,
      },
    ]);
    const presenter = createCanvasWidgetPresenter(runtime);

    await expect(
      presenter.present({
        documentUrlPath: "/__openclaw__/canvas/documents/cv_1/index.html",
        title: "Status",
        sessionContext: { sessionKey: "agent:main:status" },
      }),
    ).resolves.toEqual({
      ok: true,
      value: { nodeId: "mac-local", nodeName: "Studio" },
    });
    expect(runtime.invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nodeId: "mac-local",
        command: "canvas.present",
        params: {},
        sessionKey: "agent:main:status",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(runtime.invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        nodeId: "mac-local",
        command: "canvas.navigate",
        params: { url: "/__openclaw__/canvas/documents/cv_1/index.html" },
        sessionKey: "agent:main:status",
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it("maps missing eligible nodes and node invocation failures", async () => {
    const unavailable = createCanvasWidgetPresenter(
      createNodesRuntime([{ nodeId: "offline", connected: false, caps: ["canvas"], commands }]),
    );
    await expect(unavailable.availability({})).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });

    const runtime = createNodesRuntime([
      {
        nodeId: "mac-panel",
        connected: true,
        caps: ["canvas"],
        invocableCommands: commands,
      },
    ]);
    vi.mocked(runtime.invoke).mockRejectedValueOnce(new Error("panel disabled"));
    const presenter = createCanvasWidgetPresenter(runtime);
    await expect(
      presenter.present({
        documentUrlPath: "/__openclaw__/canvas/documents/cv_2/index.html",
        title: "Status",
        sessionContext: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "node_error", message: "panel disabled", nodeId: "mac-panel" },
    });
  });
});
