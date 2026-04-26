import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import {
  type AriaSnapshotNode,
  captureScreenshot,
  captureScreenshotPng,
  createTargetViaCdp,
  type DomSnapshotNode,
  evaluateJavaScript,
  formatAriaSnapshot,
  getDomText,
  normalizeCdpWsUrl,
  type QueryMatch,
  querySelector,
  type RawAXNode,
  snapshotAria,
  snapshotDom,
  snapshotRoleViaCdp,
} from "./cdp.js";

/**
 * Exercises the CDP session-oriented exports of cdp.ts against a local
 * `ws` server. A single `createCdpMockServer` helper echoes replies
 * keyed on method, keeping individual tests short.
 */

type CdpReplyHandler = (
  msg: { id?: number; method?: string; params?: Record<string, unknown> },
  socket: WebSocket,
) => void;
type CdpMockMessage = Parameters<CdpReplyHandler>[0];

function sendCdpResult(socket: WebSocket, id: number | undefined, result: Record<string, unknown>) {
  socket.send(JSON.stringify({ id, result }));
}

function replyToPageEnable(msg: CdpMockMessage, socket: WebSocket): boolean {
  if (msg.method !== "Page.enable") {
    return false;
  }
  sendCdpResult(socket, msg.id, {});
  return true;
}

function replyWithScreenshotData(msg: CdpMockMessage, socket: WebSocket, data: string): boolean {
  if (msg.method !== "Page.captureScreenshot") {
    return false;
  }
  sendCdpResult(socket, msg.id, { data: Buffer.from(data).toString("base64") });
  return true;
}

function replyToViewportCommandOrScreenshot(
  msg: CdpMockMessage,
  socket: WebSocket,
  data: string,
): boolean {
  if (
    msg.method === "Emulation.setDeviceMetricsOverride" ||
    msg.method === "Emulation.clearDeviceMetricsOverride"
  ) {
    sendCdpResult(socket, msg.id, {});
    return true;
  }
  return replyWithScreenshotData(msg, socket, data);
}

async function startMockWsServer(handle: CdpReplyHandler) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(rawDataToString(raw)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      handle(msg, socket);
      if (
        msg.method === "Page.enable" ||
        msg.method === "Runtime.enable" ||
        msg.method === "Network.enable" ||
        msg.method === "DOM.enable" ||
        msg.method === "Accessibility.enable" ||
        msg.method === "Runtime.runIfWaitingForDebugger"
      ) {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });
  return {
    wss,
    port,
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser/TEST`,
  };
}

describe("cdp internal", () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
  });

  async function captureScreenshotAndObserveParams(
    options: Omit<Parameters<typeof captureScreenshot>[0], "wsUrl">,
  ) {
    const observed: Array<Record<string, unknown>> = [];
    const server = await startMockWsServer((msg, socket) => {
      if (replyToPageEnable(msg, socket)) {
        return;
      }
      if (msg.method === "Page.captureScreenshot") {
        observed.push(msg.params ?? {});
        replyWithScreenshotData(msg, socket, "JPG");
      }
    });
    wss = server.wss;
    const buf = await captureScreenshot({ wsUrl: server.wsUrl, ...options });
    return { buf, observed };
  }

  describe("captureScreenshot", () => {
    it("captures a PNG without fullPage", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          expect(msg.params).toMatchObject({ format: "png" });
          expect(msg.params).not.toHaveProperty("captureBeyondViewport");
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("PNGDATA").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl });
      expect(buf.toString("utf8")).toBe("PNGDATA");
    });

    it("captureScreenshotPng forwards to the png captureScreenshot flow", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          expect(msg.params?.format).toBe("png");
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("WRAPPED").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      const buf = await captureScreenshotPng({ wsUrl: server.wsUrl });
      expect(buf.toString("utf8")).toBe("WRAPPED");
    });

    it("clamps out-of-range JPEG quality values into [0, 100]", async () => {
      const { observed } = await captureScreenshotAndObserveParams({
        format: "jpeg",
        quality: 250,
      });
      expect(observed[0]?.format).toBe("jpeg");
      expect(observed[0]?.quality).toBe(100);
    });

    it("captures fullPage and restores viewport overrides", async () => {
      const events: string[] = [];
      const server = await startMockWsServer((msg, socket) => {
        events.push(msg.method ?? "");
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { cssContentSize: { width: 2000, height: 3000 } },
            }),
          );
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          // Pre-capture viewport probe + post-capture probe.
          const isPre = events.filter((m) => m === "Runtime.evaluate").length === 1;
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: isPre
                    ? { w: 800, h: 600, dpr: 2, sw: 1600, sh: 1200 }
                    : { w: 2000, h: 3000, dpr: 2 },
                },
              },
            }),
          );
          return;
        }
        if (replyToViewportCommandOrScreenshot(msg, socket, "FULL")) {
          return;
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      expect(buf.toString("utf8")).toBe("FULL");
      expect(events).toContain("Emulation.setDeviceMetricsOverride");
      expect(events).toContain("Emulation.clearDeviceMetricsOverride");
    });

    it("restores viewport even when the post-capture probe mismatches", async () => {
      // Post probe returns a different dpr than saved → helper reapplies.
      const calls: Array<Record<string, unknown>> = [];
      let evalCount = 0;
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { contentSize: { width: 1200, height: 800 } },
            }),
          );
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          evalCount += 1;
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value:
                    evalCount === 1
                      ? { w: 400, h: 300, dpr: 1, sw: 800, sh: 600 }
                      : { w: 9999, h: 9999, dpr: 9 },
                },
              },
            }),
          );
          return;
        }
        if (msg.method === "Emulation.setDeviceMetricsOverride") {
          calls.push(msg.params ?? {});
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Emulation.clearDeviceMetricsOverride") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("PIC").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      // Two setDeviceMetricsOverride calls: expand then restore.
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it("skips viewport expansion when content size is zero", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { cssContentSize: { width: 0, height: 0 } },
            }),
          );
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("Z").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      expect(buf.toString("utf8")).toBe("Z");
    });

    it("throws when Page.captureScreenshot returns no data", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
      wss = server.wss;
      await expect(captureScreenshot({ wsUrl: server.wsUrl })).rejects.toThrow(
        /Screenshot failed: missing data/,
      );
    });
  });

  describe("createTargetViaCdp", () => {
    it("throws when Target.createTarget returns no targetId", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Target.createTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: { targetId: "" } }));
        }
      });
      wss = server.wss;
      await expect(
        createTargetViaCdp({ cdpUrl: server.wsUrl, url: "https://example.com" }),
      ).rejects.toThrow(/Target\.createTarget returned no targetId/);
    });
  });

  describe("evaluateJavaScript", () => {
    it("throws when Runtime.evaluate returns no result", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
      wss = server.wss;
      await expect(evaluateJavaScript({ wsUrl: server.wsUrl, expression: "1" })).rejects.toThrow(
        /Runtime\.evaluate returned no result/,
      );
    });

    it("surfaces CDP exceptionDetails alongside result", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                result: { type: "undefined" },
                exceptionDetails: { text: "ReferenceError", lineNumber: 1 },
              },
            }),
          );
        }
      });
      wss = server.wss;
      const res = await evaluateJavaScript({ wsUrl: server.wsUrl, expression: "boom" });
      expect(res.exceptionDetails?.text).toBe("ReferenceError");
    });
  });

  describe("formatAriaSnapshot", () => {
    it("returns an empty array when the AX tree is empty", () => {
      expect(formatAriaSnapshot([], 100)).toEqual([]);
    });

    it("returns an empty array when no node has an id", () => {
      const nodes = [{ role: { value: "Role" }, name: { value: "" } }] as unknown as RawAXNode[];
      expect(formatAriaSnapshot(nodes, 100)).toEqual([]);
    });

    it("skips child references that are absent from the node map", () => {
      const nodes: RawAXNode[] = [
        {
          nodeId: "1",
          role: { value: "Root" },
          name: { value: "" },
          childIds: ["2", "missing"],
        },
        {
          nodeId: "2",
          role: { value: "Leaf" },
          name: { value: "ok" },
          childIds: [],
        },
      ];
      const out: AriaSnapshotNode[] = formatAriaSnapshot(nodes, 100);
      // Only the root + the resolvable child — missing is dropped.
      expect(out).toHaveLength(2);
      expect(out[1]?.name).toBe("ok");
    });

    it("coerces AX values from strings, numbers, and booleans (with fallback to empty)", () => {
      const nodes: RawAXNode[] = [
        {
          nodeId: "1",
          role: { value: "Root" } as unknown as RawAXNode["role"],
          name: { value: 42 } as unknown as RawAXNode["name"],
          value: { value: true } as unknown as RawAXNode["value"],
          description: { value: {} } as unknown as RawAXNode["description"],
          childIds: [],
        },
      ];
      const out = formatAriaSnapshot(nodes, 100);
      expect(out[0]?.role).toBe("Root");
      expect(out[0]?.name).toBe("42");
      expect(out[0]?.value).toBe("true");
      // Unknown/object-shaped AX value → falls back to empty → omitted.
      expect(out[0]?.description).toBeUndefined();
    });

    it("respects the limit argument", () => {
      const nodes: RawAXNode[] = Array.from({ length: 10 }, (_, i) => ({
        nodeId: String(i + 1),
        role: { value: `Role${i + 1}` },
        name: { value: "" },
        childIds: i === 0 ? ["2", "3", "4", "5", "6", "7", "8", "9", "10"] : [],
      }));
      const out = formatAriaSnapshot(nodes, 3);
      expect(out).toHaveLength(3);
    });
  });

  describe("snapshotAria", () => {
    it("forwards the happy-path tree to formatAriaSnapshot", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Accessibility.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                nodes: [
                  { nodeId: "1", role: { value: "Root" }, name: { value: "" }, childIds: [] },
                ],
              },
            }),
          );
        }
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl, limit: 50 });
      expect(snap.nodes[0]?.role).toBe("Root");
    });

    it("returns an empty list when the server omits nodes", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Accessibility.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl });
      expect(snap.nodes).toEqual([]);
    });
  });

  describe("snapshotRoleViaCdp", () => {
    it("builds role refs, promotes cursor-interactive nodes, and appends link urls", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Accessibility.enable" || msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                nodes: [
                  {
                    nodeId: "1",
                    role: { value: "RootWebArea" },
                    name: { value: "" },
                    childIds: ["2", "3", "4"],
                  },
                  {
                    nodeId: "2",
                    role: { value: "button" },
                    name: { value: "Save" },
                    backendDOMNodeId: 22,
                    childIds: [],
                  },
                  {
                    nodeId: "3",
                    role: { value: "link" },
                    name: { value: "Docs" },
                    backendDOMNodeId: 33,
                    childIds: [],
                  },
                  {
                    nodeId: "4",
                    role: { value: "generic" },
                    name: { value: "" },
                    backendDOMNodeId: 44,
                    childIds: [],
                  },
                ],
              },
            }),
          );
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          const expression =
            typeof msg.params?.expression === "string" ? msg.params.expression : "";
          if (expression.includes('querySelectorAll("*"')) {
            socket.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    value: [
                      {
                        text: "Clickable Card",
                        tagName: "div",
                        hasCursorPointer: true,
                        hasOnClick: true,
                      },
                    ],
                  },
                },
              }),
            );
            return;
          }
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
          return;
        }
        if (msg.method === "DOM.getDocument") {
          socket.send(JSON.stringify({ id: msg.id, result: { root: { nodeId: 1 } } }));
          return;
        }
        if (msg.method === "DOM.querySelectorAll") {
          socket.send(JSON.stringify({ id: msg.id, result: { nodeIds: [44] } }));
          return;
        }
        if (msg.method === "DOM.describeNode") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { node: { backendNodeId: 44, attributes: ["data-openclaw-cdp-ci", "0"] } },
            }),
          );
          return;
        }
        if (msg.method === "DOM.resolveNode") {
          socket.send(JSON.stringify({ id: msg.id, result: { object: { objectId: "link1" } } }));
          return;
        }
        if (msg.method === "Runtime.callFunctionOn") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: "https://docs.openclaw.ai/" } },
            }),
          );
        }
      });
      wss = server.wss;

      const snap = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        urls: true,
        options: { interactive: true },
      });

      expect(snap.snapshot).toContain('- button "Save" [ref=e1]');
      expect(snap.snapshot).toContain('- link "Docs" [ref=e2] [url=https://docs.openclaw.ai/]');
      expect(snap.snapshot).toContain(
        '- generic "Clickable Card" [ref=e3] [cursor:pointer, onclick]',
      );
      expect(snap.refs.e3?.backendDOMNodeId).toBe(44);
    });

    it("expands one level of iframe snapshots with frame metadata", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (
          msg.method === "Accessibility.enable" ||
          msg.method === "Page.enable" ||
          msg.method === "Runtime.evaluate"
        ) {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: msg.method === "Runtime.evaluate" ? { result: { value: [] } } : {},
            }),
          );
          return;
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          const frameId = msg.params?.frameId;
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: {
                nodes: frameId
                  ? [
                      {
                        nodeId: "c1",
                        role: { value: "RootWebArea" },
                        name: { value: "" },
                        childIds: ["c2"],
                      },
                      {
                        nodeId: "c2",
                        role: { value: "button" },
                        name: { value: "Inside" },
                        backendDOMNodeId: 55,
                        childIds: [],
                      },
                    ]
                  : [
                      {
                        nodeId: "1",
                        role: { value: "RootWebArea" },
                        name: { value: "" },
                        childIds: ["2"],
                      },
                      {
                        nodeId: "2",
                        role: { value: "Iframe" },
                        name: { value: "Child" },
                        backendDOMNodeId: 44,
                        childIds: [],
                      },
                    ],
              },
            }),
          );
          return;
        }
        if (msg.method === "DOM.describeNode") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { node: { contentDocument: { frameId: "FRAME_1" } } },
            }),
          );
        }
      });
      wss = server.wss;

      const snap = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        options: { interactive: true },
      });

      expect(snap.snapshot).toContain('- Iframe "Child" [ref=e1]');
      expect(snap.snapshot).toContain('  - button "Inside" [ref=e2]');
      expect(snap.refs.e1?.frameId).toBe("FRAME_1");
      expect(snap.refs.e2?.frameId).toBe("FRAME_1");
    });
  });

  describe("snapshotDom", () => {
    it("returns the nodes array from the evaluated expression", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          const fake: DomSnapshotNode[] = [{ ref: "n1", parentRef: null, depth: 0, tag: "html" }];
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: { nodes: fake } } },
            }),
          );
        }
      });
      wss = server.wss;
      const snap = await snapshotDom({ wsUrl: server.wsUrl, limit: 10, maxTextChars: 200 });
      expect(snap.nodes[0]?.tag).toBe("html");
    });

    it("returns an empty nodes array when the value is not an object", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: null } },
            }),
          );
        }
      });
      wss = server.wss;
      const snap = await snapshotDom({ wsUrl: server.wsUrl });
      expect(snap.nodes).toEqual([]);
    });

    it("returns an empty nodes array when nodes is not an array", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: { nodes: "not-an-array" } } },
            }),
          );
        }
      });
      wss = server.wss;
      const snap = await snapshotDom({ wsUrl: server.wsUrl });
      expect(snap.nodes).toEqual([]);
    });
  });

  describe("getDomText", () => {
    it("returns the evaluated string for text format", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: "plain body text" } },
            }),
          );
        }
      });
      wss = server.wss;
      const res = await getDomText({ wsUrl: server.wsUrl, format: "text", maxChars: 100 });
      expect(res.text).toBe("plain body text");
    });

    it("returns the html outerHTML for html format with a selector", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: "<div>html</div>" } },
            }),
          );
        }
      });
      wss = server.wss;
      const res = await getDomText({
        wsUrl: server.wsUrl,
        format: "html",
        selector: "#foo",
      });
      expect(res.text).toBe("<div>html</div>");
    });

    it("coerces numeric/boolean values to strings and falls back to empty for objects", async () => {
      const responses: unknown[] = [42, true, { shape: "object" }];
      let i = 0;
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: responses[i++] } },
            }),
          );
        }
      });
      wss = server.wss;
      const num = await getDomText({ wsUrl: server.wsUrl, format: "text" });
      expect(num.text).toBe("42");
      const bool = await getDomText({ wsUrl: server.wsUrl, format: "text" });
      expect(bool.text).toBe("true");
      const obj = await getDomText({ wsUrl: server.wsUrl, format: "text" });
      expect(obj.text).toBe("");
    });
  });

  describe("querySelector", () => {
    it("returns the matches array from the evaluated expression", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          const matches: QueryMatch[] = [{ index: 1, tag: "button", text: "OK" }];
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: matches } } }));
        }
      });
      wss = server.wss;
      const out = await querySelector({
        wsUrl: server.wsUrl,
        selector: "button",
        limit: 5,
        maxTextChars: 100,
        maxHtmlChars: 500,
      });
      expect(out.matches[0]?.tag).toBe("button");
    });

    it("returns an empty array when the value is not an array", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: "not-array" } } }));
        }
      });
      wss = server.wss;
      const out = await querySelector({ wsUrl: server.wsUrl, selector: "button" });
      expect(out.matches).toEqual([]);
    });
  });

  describe("normalizeCdpWsUrl fill-in", () => {
    it("respects an already-non-loopback ws hostname (no-rewrite branch)", () => {
      // Covers the else side of the loopback/wildcard-guard in normalizeCdpWsUrl.
      const out = normalizeCdpWsUrl(
        "ws://non-loopback.example:9222/devtools/browser/ABC",
        "http://non-loopback.example:9222",
      );
      expect(out).toContain("non-loopback.example:9222");
    });

    it("falls back to protocol-default ports when the cdp URL omits a port", () => {
      // Covers the right-hand side of `cdp.port || (cdp.protocol === 'https:' ? '443' : '80')`.
      // WHATWG URL elides default ports (443 for wss, 80 for ws) in the
      // serialized form, so we assert the scheme + host rather than port.
      const secure = normalizeCdpWsUrl(
        "ws://127.0.0.1:9222/devtools/browser/ABC",
        "https://example.com/",
      );
      expect(secure).toBe("wss://example.com/devtools/browser/ABC");
      const plain = normalizeCdpWsUrl(
        "ws://127.0.0.1:9222/devtools/browser/ABC",
        "http://example.com/",
      );
      expect(plain).toBe("ws://example.com/devtools/browser/ABC");
    });
  });

  describe("captureScreenshot branch coverage", () => {
    it("uses the default jpeg quality when opts.quality is omitted", async () => {
      const { observed } = await captureScreenshotAndObserveParams({ format: "jpeg" });
      expect(observed[0]?.quality).toBe(85);
    });

    it("defaults fullPage content/viewport fields to 0 when the page reports nothing", async () => {
      // Covers the right-hand sides of `size?.width ?? 0`, `size?.height ?? 0`,
      // `v?.w ?? 0`, `v?.h ?? 0`, `v?.dpr ?? 1`, `v?.sw ?? currentW`, `v?.sh ?? currentH`.
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          // Both cssContentSize and contentSize absent — forces the
          // `?? 0` default on width/height.
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("N").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      expect(buf.toString("utf8")).toBe("N");
    });

    it("falls back to the non-css contentSize when cssContentSize is absent", async () => {
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { contentSize: { width: 100, height: 200 } },
            }),
          );
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          // viewport probe with a completely empty value to exercise all
          // `v?.X ?? default` branches.
          socket.send(JSON.stringify({ id: msg.id, result: { result: { value: {} } } }));
          return;
        }
        if (replyToViewportCommandOrScreenshot(msg, socket, "C")) {
          return;
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      expect(buf.toString("utf8")).toBe("C");
    });
  });

  describe("createTargetViaCdp branch coverage", () => {
    it("normalises a bare ws:// CDP URL to http for /json/version discovery", async () => {
      // Covers the truthy side of `isWebSocketUrl(opts.cdpUrl) ? normalize... : opts.cdpUrl`
      // in createTargetViaCdp — the bare-ws root triggers discovery.
      const http = await import("node:http");
      const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => wsServer.once("listening", () => resolve()));
      const wsPort = (wsServer.address() as { port: number }).port;
      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
          if (msg.method === "Target.createTarget") {
            socket.send(JSON.stringify({ id: msg.id, result: { targetId: "T_BARE_WS" } }));
          }
        });
      });
      const httpServer = http.createServer((req, res) => {
        if (req.url === "/json/version") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/BARE_WS`,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      const httpPort = (httpServer.address() as { port: number }).port;
      try {
        const out = await createTargetViaCdp({
          cdpUrl: `ws://127.0.0.1:${httpPort}`, // bare ws root → forces discovery
          url: "https://example.com",
        });
        expect(out.targetId).toBe("T_BARE_WS");
      } finally {
        await new Promise<void>((resolve) => wsServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    });

    it("throws when Target.createTarget returns a missing (undefined) targetId", async () => {
      // Covers the right-hand side of `created?.targetId?.trim() ?? ""` (?? "").
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Target.createTarget") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
      wss = server.wss;
      await expect(
        createTargetViaCdp({ cdpUrl: server.wsUrl, url: "https://example.com" }),
      ).rejects.toThrow(/Target\.createTarget returned no targetId/);
    });
  });

  describe("formatAriaSnapshot branch coverage", () => {
    it("falls back to 'unknown' role and omits empty value/description", () => {
      // role "" triggers `role || "unknown"`; value/description empty
      // triggers the falsy side of `value ? { value } : {}`.
      const nodes: RawAXNode[] = [
        {
          nodeId: "1",
          role: { value: "" },
          name: { value: "n" },
          value: { value: "" },
          description: { value: "" },
          childIds: [],
        },
      ];
      const out = formatAriaSnapshot(nodes, 100);
      expect(out[0]?.role).toBe("unknown");
      expect(out[0]?.value).toBeUndefined();
      expect(out[0]?.description).toBeUndefined();
    });

    it("includes the description field when the AX node provides a truthy description", () => {
      // Covers the truthy side of `description ? { description } : {}`.
      const nodes: RawAXNode[] = [
        {
          nodeId: "1",
          role: { value: "Button" },
          name: { value: "n" },
          description: { value: "explanatory" },
          childIds: [],
        },
      ];
      const out = formatAriaSnapshot(nodes, 100);
      expect(out[0]?.description).toBe("explanatory");
    });

    it("defaults childIds to an empty array when the AX node omits the field", () => {
      // Covers the right-hand side of `(n.childIds ?? [])`.
      const nodes: RawAXNode[] = [
        {
          nodeId: "solo",
          role: { value: "Leaf" },
          name: { value: "" },
        },
      ];
      const out = formatAriaSnapshot(nodes, 100);
      expect(out).toHaveLength(1);
    });
  });

  describe(".catch(() => {}) swallow arrows", () => {
    it("swallows a failing Accessibility.enable in snapshotAria", async () => {
      // Exercises the `.catch(() => {})` arrow on `Accessibility.enable`.
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Accessibility.enable") {
          socket.send(JSON.stringify({ id: msg.id, error: { message: "denied" } }));
          return;
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          socket.send(JSON.stringify({ id: msg.id, result: { nodes: [] } }));
        }
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl });
      expect(snap.nodes).toEqual([]);
    });

    it("swallows a failing Runtime.enable in evaluateJavaScript", async () => {
      // Exercises the `.catch(() => {})` arrow on `Runtime.enable`.
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, error: { message: "denied" } }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { type: "number", value: 1 } },
            }),
          );
        }
      });
      wss = server.wss;
      const res = await evaluateJavaScript({ wsUrl: server.wsUrl, expression: "1" });
      expect(res.result.value).toBe(1);
    });

    it("swallows a failing Emulation.clearDeviceMetricsOverride in the screenshot finally", async () => {
      // Exercises the `.catch(() => {})` on clearDeviceMetricsOverride inside
      // the fullPage finally block.
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { cssContentSize: { width: 800, height: 600 } },
            }),
          );
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { result: { value: { w: 400, h: 300, dpr: 1, sw: 800, sh: 600 } } },
            }),
          );
          return;
        }
        if (msg.method === "Emulation.setDeviceMetricsOverride") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Emulation.clearDeviceMetricsOverride") {
          socket.send(JSON.stringify({ id: msg.id, error: { message: "denied" } }));
          return;
        }
        if (msg.method === "Page.captureScreenshot") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("S").toString("base64") },
            }),
          );
        }
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl, fullPage: true });
      expect(buf.toString("utf8")).toBe("S");
    });
  });

  describe("getDomText branch coverage", () => {
    it("coerces a missing evaluated value to an empty string", async () => {
      // Covers the right-hand side of `evaluated.result?.value ?? ""`.
      const server = await startMockWsServer((msg, socket) => {
        if (msg.method === "Runtime.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "Runtime.evaluate") {
          socket.send(JSON.stringify({ id: msg.id, result: { result: {} } }));
        }
      });
      wss = server.wss;
      const res = await getDomText({ wsUrl: server.wsUrl, format: "text" });
      expect(res.text).toBe("");
    });
  });
});
