import type { Page } from "playwright-core";
import { z } from "zod";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";

const METHODS = [
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.attachToTarget",
  "Page.navigate",
  "Page.frameNavigated",
  "Page.frameDetached",
  "Page.lifecycleEvent",
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.requestPaused",
  "Fetch.continueRequest",
  "Fetch.continueResponse",
  "Fetch.fulfillRequest",
  "Fetch.failRequest",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
] as const;
const id = z.string().max(200).optional();
const fields = z.object({
  sessionId: id,
  targetId: id,
  requestId: id,
  networkId: id,
  frameId: id,
  loaderId: id,
  name: z.string().optional(),
  frame: z.object({ id, loaderId: id }).optional(),
  targetInfo: z.object({ targetId: id }).optional(),
});
const envelope = z.object({
  id: z.number().int().optional(),
  method: z.enum(METHODS).optional(),
  sessionId: id,
  params: fields.optional(),
  result: fields.extend({ errorText: z.string().optional() }).optional(),
  error: z.unknown().optional(),
});
type Method = (typeof METHODS)[number];
type Phase =
  | "injection.used"
  | "injection.calls"
  | "adapter.fresh"
  | "navigate.status"
  | "owner.selected"
  | "owner.unrelated"
  | "direct.url"
  | "unrelated.url"
  | "direct.commit"
  | "direct.domcontentloaded"
  | "direct.load"
  | "direct.closed"
  | "http.request"
  | "http.finish"
  | "http.closed"
  | "relay.clients"
  | "relay.closed"
  | "mcp.closed";
type RecordEntry = { phase: string; [key: string]: string | number | boolean };

// Stage-one fixture observation only: no extension rewrite, new CDP client/domain,
// event replay, or action waits. Stop retaining data at the cap, including during cleanup.
export function createBootstrapDiagnostic() {
  const started = performance.now();
  const records: RecordEntry[] = [];
  const ordinals = new Map<string, number>();
  const pending = new Map<string, { method: Method; command: number }>();
  const restores: Array<() => void> = [];
  let remaining = 256;
  let dropped = 0;
  let active = false;
  let nextClient = 0;
  let nextCommand = 0;
  let flushes = 0;
  const append = (entry: RecordEntry) => {
    if (remaining === 0) {
      dropped = Math.min(dropped + 1, 1_000_000);
      return;
    }
    remaining--;
    records.push({ ms: Math.round(performance.now() - started), ...entry });
  };
  const ordinal = (kind: string, value: string | undefined) => {
    if (value === undefined) {
      return 0;
    }
    const key = `${kind}:${value}`;
    const found = ordinals.get(key);
    if (found) {
      return found;
    }
    if (ordinals.size === 128) {
      return 0;
    }
    const next = ordinals.size + 1;
    ordinals.set(key, next);
    return next;
  };
  const observe = (client: number, outgoing: boolean, raw: string) => {
    if (!active) {
      return;
    }
    // Reserve the final records for action outcome and teardown, even on event floods.
    if (remaining <= 32 || raw.length > 64 * 1024) {
      dropped = Math.min(dropped + 1, 1_000_000);
      return;
    }
    try {
      const parsed = envelope.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return;
      }
      const msg = parsed.data;
      const key = `${client}:${msg.id}`;
      const command = outgoing ? pending.get(key) : undefined;
      if (outgoing) {
        pending.delete(key);
      }
      const method = command?.method ?? msg.method;
      if (!method) {
        return;
      }
      const commandId = command?.command ?? (!outgoing ? ++nextCommand : 0);
      if (!outgoing && msg.id !== undefined && pending.size < 128) {
        pending.set(key, { method, command: commandId });
      }
      const data = msg.params ?? msg.result;
      append({
        phase: !outgoing ? "cdp.command" : command ? "cdp.result" : "cdp.event",
        client,
        method,
        command: commandId,
        session: ordinal("session", msg.sessionId ?? data?.sessionId),
        childSession: ordinal("session", data?.sessionId),
        target: ordinal("target", data?.targetId ?? data?.targetInfo?.targetId),
        request: ordinal(method.startsWith("Fetch.") ? "fetch" : "network", data?.requestId),
        network: ordinal("network", data?.networkId),
        frame: ordinal("frame", data?.frameId ?? data?.frame?.id),
        loader: ordinal("loader", data?.loaderId ?? data?.frame?.loaderId),
        load: data?.name === "load",
        domContentLoaded: data?.name === "DOMContentLoaded",
        error: msg.error !== undefined || Boolean(msg.result?.errorText),
      });
    } catch {
      // Observation must not replace a transport result/error, including malformed input.
    }
  };
  const mark = (phase: Phase, value: boolean | number) => append({ phase, value });
  return {
    mark,
    arm(selected: string, unrelated: string) {
      active = true;
      append({
        phase: "armed",
        selected: ordinal("target", selected),
        unrelated: ordinal("target", unrelated),
      });
    },
    watchRelay(bridge: Pick<ExtensionRelayBridge, "attachCdpClientSocket" | "cdpClientCount">) {
      const original = bridge.attachCdpClientSocket;
      bridge.attachCdpClientSocket = (socket) => {
        const client = Math.min(++nextClient, 1_000_000);
        const callbacks = original.call(bridge, {
          send: (raw) => {
            observe(client, true, raw);
            socket.send(raw);
          },
          close: (code, reason) => socket.close(code, reason),
        });
        append({ phase: "client.attach", client, count: bridge.cdpClientCount });
        return {
          onMessage: (raw) => {
            observe(client, false, raw);
            callbacks.onMessage(raw);
          },
          onClose: async () => {
            try {
              await callbacks.onClose();
            } finally {
              append({ phase: "client.close", client, count: bridge.cdpClientCount });
            }
          },
        };
      };
      restores.push(() => {
        bridge.attachCdpClientSocket = original;
      });
    },
    watchPage(page: Page, expectedUrl: string) {
      const commit = (frame: ReturnType<Page["mainFrame"]>) => {
        if (frame === page.mainFrame()) {
          mark("direct.commit", page.url() === expectedUrl);
        }
      };
      const ready = () => mark("direct.domcontentloaded", page.url() === expectedUrl);
      const loaded = () => mark("direct.load", page.url() === expectedUrl);
      const closed = () => mark("direct.closed", true);
      page
        .on("framenavigated", commit)
        .on("domcontentloaded", ready)
        .on("load", loaded)
        .on("close", closed);
      const stop = () => {
        page
          .off("framenavigated", commit)
          .off("domcontentloaded", ready)
          .off("load", loaded)
          .off("close", closed);
      };
      restores.push(stop);
      return stop;
    },
    peer(info: { name: string; version: string } | undefined) {
      // Actual cached MCP peer's handshake metadata, not an npx/latest version guess.
      const version =
        info?.name === "chrome_devtools" && /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(info.version);
      append({
        phase: "mcp.peer",
        known: Boolean(version),
        major: version ? Number(version[1]) : 0,
        minor: version ? Number(version[2]) : 0,
        patch: version ? Number(version[3]) : 0,
      });
    },
    flush() {
      if (++flushes > 2) {
        return;
      }
      active = false;
      try {
        process.stderr.write(
          `[browser-bootstrap-diagnostic] ${JSON.stringify({ stage: 1, instrumentedFixture: true, extensionCopyModified: false, dropped, records })}\n`,
        );
      } catch {
        /* A diagnostic sink cannot replace the original test failure. */
      }
      records.length = 0;
    },
    dispose() {
      for (const restore of restores) {
        restore();
      }
      pending.clear();
      ordinals.clear();
    },
  };
}
