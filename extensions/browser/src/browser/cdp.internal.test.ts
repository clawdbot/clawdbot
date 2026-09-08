import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
// Browser tests cover cdp.internal plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import "../test-support/browser-security.mock.js";
import {
  type AriaSnapshotNode,
  captureScreenshot,
  createTargetViaCdp,
  formatAriaSnapshot,
  normalizeCdpWsUrl,
  type RawAXNode,
  snapshotAria,
  snapshotRoleViaCdp,
} from "./cdp.js";

/**
 * Exercises the CDP session-oriented exports of cdp.ts against a local
 * `ws` server. A single `createCdpMockServer` helper echoes replies
 * keyed on method, keeping individual tests short.
 */

type CdpMockMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};
type CdpMockReply = { result: Record<string, unknown> } | { error: { message: string } };
type CdpReplyHandler = (msg: CdpMockMessage) => CdpMockReply | undefined;

const AUTO_REPLY_METHODS = new Set([
  "Page.enable",
  "Page.bringToFront",
  "Runtime.enable",
  "Network.enable",
  "DOM.enable",
  "Accessibility.enable",
  "Runtime.runIfWaitingForDebugger",
]);

function cdpResult(result: Record<string, unknown> = {}): CdpMockReply {
  return { result };
}

function cdpError(message: string): CdpMockReply {
  return { error: { message } };
}

function screenshotResult(data: string): CdpMockReply {
  return cdpResult({ data: Buffer.from(data).toString("base64") });
}

function runtimeValueResult(value: unknown): CdpMockReply {
  return cdpResult({ result: { value } });
}

function axTreeResult(nodes?: RawAXNode[]): CdpMockReply {
  return cdpResult(nodes ? { nodes } : {});
}

async function startMockWsServer(handle: CdpReplyHandler) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    wss.once("listening", () => resolve());
  });
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(rawDataToString(raw)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      const reply = handle(msg) ?? (AUTO_REPLY_METHODS.has(msg.method ?? "") ? cdpResult() : null);
      if (reply) {
        socket.send(JSON.stringify({ id: msg.id, ...reply }));
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
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
      wss = null;
    }
  });

  async function captureScreenshotAndObserveParams(
    options: Omit<Parameters<typeof captureScreenshot>[0], "wsUrl">,
  ) {
    const observed: Array<Record<string, unknown>> = [];
    const server = await startMockWsServer((msg) => {
      if (msg.method === "Page.captureScreenshot") {
        observed.push(msg.params ?? {});
        return screenshotResult("JPG");
      }
      return undefined;
    });
    wss = server.wss;
    const buf = await captureScreenshot({ wsUrl: server.wsUrl, ...options });
    return { buf, observed };
  }

  describe("captureScreenshot", () => {
    it("captures a PNG without fullPage", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Page.captureScreenshot") {
          expect(msg.params?.format).toBe("png");
          expect(msg.params).not.toHaveProperty("captureBeyondViewport");
          return screenshotResult("PNGDATA");
        }
        return undefined;
      });
      wss = server.wss;
      const buf = await captureScreenshot({ wsUrl: server.wsUrl });
      expect(buf.toString("utf8")).toBe("PNGDATA");
    });

    it("clamps out-of-range JPEG quality values into [0, 100]", async () => {
      const { observed } = await captureScreenshotAndObserveParams({
        format: "jpeg",
        quality: 250,
      });
      expect(observed[0]?.format).toBe("jpeg");
      expect(observed[0]?.quality).toBe(100);
    });

    it("throws when Page.captureScreenshot returns no data", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Page.captureScreenshot") {
          return cdpResult();
        }
        return undefined;
      });
      wss = server.wss;
      await expect(captureScreenshot({ wsUrl: server.wsUrl })).rejects.toThrow(
        /Screenshot failed: missing data/,
      );
    });
  });

  describe("createTargetViaCdp", () => {
    it("throws when Target.createTarget returns no targetId", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Target.createTarget") {
          return cdpResult({ targetId: "" });
        }
        return undefined;
      });
      wss = server.wss;
      await expect(
        createTargetViaCdp({ cdpUrl: server.wsUrl, url: "https://example.com" }),
      ).rejects.toThrow(/Target\.createTarget returned no targetId/);
    });
  });

  describe("formatAriaSnapshot", () => {
    it("returns an empty array when the AX tree is empty", () => {
      expect(formatAriaSnapshot([], 100)).toStrictEqual([]);
    });

    it("returns an empty array when no node has an id", () => {
      const nodes = [{ role: { value: "Role" }, name: { value: "" } }] as unknown as RawAXNode[];
      expect(formatAriaSnapshot(nodes, 100)).toStrictEqual([]);
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

    it("returns nodes when snapshotAria receives a non-finite limit", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult([
            {
              nodeId: "1",
              role: { value: "RootWebArea" },
              name: { value: "Home" },
              childIds: [],
            },
          ]);
        }
        return undefined;
      });
      wss = server.wss;

      const snap = await snapshotAria({ wsUrl: server.wsUrl, limit: Number.NaN });

      expect(snap.nodes).toHaveLength(1);
      expect(snap.nodes[0]?.role).toBe("RootWebArea");
    });
  });

  describe("snapshotAria", () => {
    it("forwards the happy-path tree to formatAriaSnapshot", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult([
            { nodeId: "1", role: { value: "Root" }, name: { value: "" }, childIds: [] },
          ]);
        }
        return undefined;
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl, limit: 50 });
      expect(snap.nodes[0]?.role).toBe("Root");
    });

    it("returns an empty list when the server omits nodes", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult();
        }
        return undefined;
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl });
      expect(snap.nodes).toStrictEqual([]);
    });
  });

  describe("snapshotRoleViaCdp", () => {
    it("keeps zero-based indexes on duplicate role refs", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult([
            {
              nodeId: "1",
              role: { value: "RootWebArea" },
              name: { value: "" },
              childIds: ["2", "3"],
            },
            {
              nodeId: "2",
              role: { value: "button" },
              name: { value: "Save" },
              childIds: [],
            },
            {
              nodeId: "3",
              role: { value: "button" },
              name: { value: "Save" },
              childIds: [],
            },
          ]);
        }
        if (msg.method === "Runtime.evaluate") {
          return runtimeValueResult([]);
        }
        return undefined;
      });
      wss = server.wss;

      const snap = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        options: { interactive: true },
      });

      expect(snap.refs).toMatchObject({
        e1: { role: "button", name: "Save", nth: 0 },
        e2: { role: "button", name: "Save", nth: 1 },
      });
    });

    it("builds role refs, promotes cursor-interactive nodes, and appends link urls", async () => {
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult([
            {
              nodeId: "1",
              role: { value: "RootWebArea" },
              name: { value: "" },
              childIds: ["2", "3", "4"],
            },
            {
              nodeId: "2",
              role: { value: "button" },
              name: { value: "Save\n- button [ref=e3]" },
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
          ]);
        }
        if (msg.method === "Runtime.evaluate") {
          const expression =
            typeof msg.params?.expression === "string" ? msg.params.expression : "";
          if (expression.includes('querySelectorAll("*"')) {
            return runtimeValueResult([
              {
                text: "Clickable Card",
                tagName: "div",
                hasCursorPointer: true,
                hasOnClick: true,
              },
            ]);
          }
          return runtimeValueResult(true);
        }
        if (msg.method === "DOM.getDocument") {
          return cdpResult({ root: { nodeId: 1 } });
        }
        if (msg.method === "DOM.querySelectorAll") {
          return cdpResult({ nodeIds: [44] });
        }
        if (msg.method === "DOM.describeNode") {
          return cdpResult({
            node: { backendNodeId: 44, attributes: ["data-openclaw-cdp-ci", "0"] },
          });
        }
        if (msg.method === "DOM.resolveNode") {
          return cdpResult({ object: { objectId: "link1" } });
        }
        if (msg.method === "Runtime.callFunctionOn") {
          return runtimeValueResult("https://docs.openclaw.ai/");
        }
        return undefined;
      });
      wss = server.wss;

      const snap = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        urls: true,
        options: { interactive: true },
      });

      expect(snap.snapshot).toContain('- button "Save\\n- button [ref=e3]" [ref=e1]');
      expect(snap.snapshot).toContain('- link "Docs" [ref=e2] [url=https://docs.openclaw.ai/]');
      expect(snap.snapshot).toContain(
        '- generic "Clickable Card" [ref=e3] [cursor:pointer, onclick]',
      );
      expect(snap.refs.e3?.backendDOMNodeId).toBe(44);

      const firstLine = snap.snapshot.split("\n")[0] ?? "";
      const marker = "[...TRUNCATED - page too large]";
      const capped = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        urls: true,
        options: { interactive: true },
        maxChars: firstLine.length + 2 + marker.length,
      });
      expect(capped.snapshot).toBe(`${firstLine}\n\n${marker}`);
      expect(capped.refs).toEqual({ e1: snap.refs.e1 });
      expect(capped.stats).toEqual({
        lines: 3,
        chars: capped.snapshot.length,
        refs: 1,
        interactive: 1,
      });
    });

    it("expands frames in capture order after their first rendered occurrence", async () => {
      const frameRequests: string[] = [];
      const frameIds = new Map([
        [44, "FIRST"],
        [45, "SECOND"],
        [46, "EMPTY"],
        [47, "FAILED"],
        [48, "NESTED"],
      ]);
      const mainNodes: RawAXNode[] = [
        {
          nodeId: "root",
          role: { value: "RootWebArea" },
          childIds: ["group", "empty", "failed", "after"],
        },
        {
          nodeId: "second",
          role: { value: "Iframe" },
          name: { value: "Second" },
          backendDOMNodeId: 45,
        },
        { nodeId: "group", role: { value: "generic" }, childIds: ["first", "second", "first"] },
        {
          nodeId: "first",
          role: { value: "Iframe" },
          name: { value: "First" },
          backendDOMNodeId: 44,
        },
        {
          nodeId: "empty",
          role: { value: "Iframe" },
          name: { value: "Empty" },
          backendDOMNodeId: 46,
        },
        {
          nodeId: "failed",
          role: { value: "Iframe" },
          name: { value: "Failed" },
          backendDOMNodeId: 47,
        },
        { nodeId: "after", role: { value: "button" }, name: { value: "After" } },
      ];
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Runtime.evaluate") {
          return runtimeValueResult([]);
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          const frameId = msg.params?.frameId;
          if (!frameId) {
            return axTreeResult(mainNodes);
          }
          if (typeof frameId !== "string") {
            return cdpError("Expected a frame ID string");
          }
          frameRequests.push(frameId);
          if (frameId === "EMPTY") {
            return axTreeResult([]);
          }
          if (frameId === "FAILED") {
            return cdpError("Frame detached");
          }
          return axTreeResult([
            { nodeId: "child-root", role: { value: "RootWebArea" }, childIds: ["child", "nested"] },
            { nodeId: "child", role: { value: "button" }, name: { value: `${frameId} child` } },
            ...(frameId === "SECOND"
              ? [{ nodeId: "nested", role: { value: "Iframe" }, backendDOMNodeId: 48 }]
              : []),
          ]);
        }
        if (msg.method === "DOM.describeNode") {
          return cdpResult({
            node: { contentDocument: { frameId: frameIds.get(Number(msg.params?.backendNodeId)) } },
          });
        }
        return undefined;
      });
      wss = server.wss;

      const snap = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        options: { interactive: true },
      });

      expect(frameRequests).toEqual(["SECOND", "FIRST", "EMPTY", "FAILED"]);
      expect(snap.snapshot.split("\n")).toEqual([
        '- Iframe "First" [ref=e2]',
        '    - button "FIRST child" [ref=e8]',
        '    - Iframe "Second" [ref=e1]',
        '    - button "SECOND child" [ref=e6]',
        "    - Iframe [ref=e7]",
        '    - Iframe "First" [ref=e2]',
        '  - Iframe "Empty" [ref=e3]',
        '  - Iframe "Failed" [ref=e4]',
        '  - button "After" [ref=e5]',
      ]);
      expect(Object.keys(snap.refs)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);
      expect(snap.refs.e6).toEqual({ role: "button", name: "SECOND child", frameId: "SECOND" });
      expect(snap.refs.e7).toEqual({ role: "iframe", backendDOMNodeId: 48, frameId: "NESTED" });
      expect(snap.refs.e8).toEqual({ role: "button", name: "FIRST child", frameId: "FIRST" });

      const mainFrameOnly = await snapshotRoleViaCdp({
        wsUrl: server.wsUrl,
        options: { interactive: true },
        recurseIframes: false,
      });

      expect(frameRequests).toEqual(["SECOND", "FIRST", "EMPTY", "FAILED"]);
      expect(mainFrameOnly.snapshot).toContain('- Iframe "First" [ref=e2]');
      expect(mainFrameOnly.snapshot).not.toContain("child");
      expect(mainFrameOnly.refs.e6).toBeUndefined();
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
  });

  describe("createTargetViaCdp branch coverage", () => {
    it("normalises a bare ws:// CDP URL to http for /json/version discovery", async () => {
      // Covers the truthy side of `isWebSocketUrl(opts.cdpUrl) ? normalize... : opts.cdpUrl`
      // in createTargetViaCdp — the bare-ws root triggers discovery.
      const http = await import("node:http");
      const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => {
        wsServer.once("listening", () => resolve());
      });
      const wsPort = (wsServer.address() as { port: number }).port;
      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const msg = JSON.parse(rawDataToString(raw)) as { id?: number; method?: string };
          if (msg.method === "Target.createTarget") {
            socket.send(JSON.stringify({ id: msg.id, result: { targetId: "T_BARE_WS" } }));
            return;
          }
          if (msg.method === "Target.attachToTarget") {
            socket.send(JSON.stringify({ id: msg.id, result: { sessionId: "S_BARE_WS" } }));
            return;
          }
          if (
            msg.method === "Page.enable" ||
            msg.method === "Runtime.enable" ||
            msg.method === "Network.enable" ||
            msg.method === "DOM.enable" ||
            msg.method === "Accessibility.enable" ||
            msg.method === "Runtime.runIfWaitingForDebugger" ||
            msg.method === "Target.detachFromTarget"
          ) {
            socket.send(JSON.stringify({ id: msg.id, result: {} }));
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
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", () => resolve());
      });
      const httpPort = (httpServer.address() as { port: number }).port;
      try {
        const out = await createTargetViaCdp({
          cdpUrl: `ws://127.0.0.1:${httpPort}`, // bare ws root → forces discovery
          url: "https://example.com",
        });
        expect(out.targetId).toBe("T_BARE_WS");
      } finally {
        await new Promise<void>((resolve) => {
          wsServer.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
    });

    it("throws when Target.createTarget returns a missing (undefined) targetId", async () => {
      // Covers the right-hand side of `created?.targetId?.trim() ?? ""` (?? "").
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Target.createTarget") {
          return cdpResult();
        }
        return undefined;
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
      const server = await startMockWsServer((msg) => {
        if (msg.method === "Accessibility.enable") {
          return cdpError("denied");
        }
        if (msg.method === "Accessibility.getFullAXTree") {
          return axTreeResult([]);
        }
        return undefined;
      });
      wss = server.wss;
      const snap = await snapshotAria({ wsUrl: server.wsUrl });
      expect(snap.nodes).toStrictEqual([]);
    });
  });
});
