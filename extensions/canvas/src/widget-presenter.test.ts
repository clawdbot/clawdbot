import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCanvasWidgetPresenter } from "./widget-presenter.js";

const commands = ["canvas.present"];

function createNodesRuntime(
  nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
): PluginRuntime["nodes"] {
  return {
    list: vi.fn(async () => ({ nodes })),
    invoke: vi.fn(async () => ({ ok: true })),
  };
}

describe("Canvas widget presenter", () => {
  it("prefers the existing local Mac default and presents the hosted URL atomically", async () => {
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
        document: {
          kind: "html",
          html: "<p>Status</p>",
          hostedUrl: "/__openclaw__/canvas/documents/cv_1/index.html",
        },
        title: "Status",
        context: { sessionKey: "agent:main:status" },
      }),
    ).resolves.toEqual({
      ok: true,
      value: { kind: "node", nodeId: "mac-local", nodeName: "Studio" },
    });
    expect(runtime.invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nodeId: "mac-local",
        command: "canvas.present",
        params: { url: "/__openclaw__/canvas/documents/cv_1/index.html" },
        sessionKey: "agent:main:status",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
  });

  it("maps missing eligible nodes and node invocation failures", async () => {
    const unavailable = createCanvasWidgetPresenter(
      createNodesRuntime([
        {
          nodeId: "offline",
          platform: "macos",
          connected: false,
          caps: ["canvas"],
          commands,
        },
      ]),
    );
    await expect(unavailable.availability({})).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });

    const runtime = createNodesRuntime([
      {
        nodeId: "mac-panel",
        platform: "macos",
        connected: true,
        caps: ["canvas"],
        invocableCommands: commands,
      },
    ]);
    vi.mocked(runtime.invoke).mockRejectedValueOnce(new Error("panel disabled"));
    const presenter = createCanvasWidgetPresenter(runtime);
    await expect(
      presenter.present({
        document: {
          kind: "html",
          html: "<p>Status</p>",
          hostedUrl: "/__openclaw__/canvas/documents/cv_2/index.html",
        },
        title: "Status",
        context: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "node_error", message: "panel disabled", nodeId: "mac-panel" },
    });
  });

  it("leaves no stale visible content when atomic presentation fails", async () => {
    const documentUrlPath = "/__openclaw__/canvas/documents/cv_partial/index.html";
    const panel = { visible: false, url: undefined as string | undefined };
    const transcript: Array<{ command: string; params: unknown }> = [];
    const runtime = createNodesRuntime([
      {
        nodeId: "mac-panel",
        platform: "macos",
        connected: true,
        caps: ["canvas"],
        invocableCommands: commands,
      },
    ]);
    vi.mocked(runtime.invoke).mockImplementation(async ({ command, params }) => {
      transcript.push({ command, params });
      if (command === "canvas.present") {
        if ((params as { url?: unknown } | undefined)?.url === documentUrlPath) {
          throw new Error("presentation rejected");
        }
        panel.visible = true;
        panel.url = "default";
        return { ok: true };
      }
      throw new Error("navigation rejected after presentation");
    });

    const result = await createCanvasWidgetPresenter(runtime).present({
      document: { kind: "html", html: "<p>Status</p>", hostedUrl: documentUrlPath },
      title: "Status",
      context: {},
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "node_error", message: "presentation rejected", nodeId: "mac-panel" },
    });
    expect({ panel, transcript }).toEqual({
      panel: { visible: false, url: undefined },
      transcript: [{ command: "canvas.present", params: { url: documentUrlPath } }],
    });
  });

  it("rejects Linux nodes that cannot resolve hosted document paths", async () => {
    const runtime = createNodesRuntime([
      {
        nodeId: "linux-panel",
        platform: "linux",
        connected: true,
        caps: ["canvas"],
        invocableCommands: commands,
      },
    ]);
    const presenter = createCanvasWidgetPresenter(runtime);

    await expect(presenter.availability({})).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });
    await expect(
      presenter.present({
        document: {
          kind: "html",
          html: "<p>Status</p>",
          hostedUrl: "/__openclaw__/canvas/documents/cv_linux/index.html",
        },
        title: "Status",
        context: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "no_eligible_node" },
    });
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
});
