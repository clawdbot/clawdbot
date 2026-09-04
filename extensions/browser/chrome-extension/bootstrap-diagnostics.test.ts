import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { createBootstrapDiagnostic } from "./bootstrap-diagnostics.test-support.js";

afterEach(() => vi.restoreAllMocks());

function observerFixture() {
  let count = 0;
  let reply: ((raw: string) => void) | undefined;
  const receive = vi.fn();
  const bridge = {
    get cdpClientCount() {
      return count;
    },
    attachCdpClientSocket(this: void, socket) {
      count++;
      reply = socket.send;
      return {
        onMessage: receive,
        onClose: async () => {
          count--;
          socket.close();
        },
      };
    },
  } satisfies Pick<ExtensionRelayBridge, "attachCdpClientSocket" | "cdpClientCount">;
  return { bridge, receive, reply: (raw: string) => reply?.(raw) };
}

describe("bootstrap diagnostic observation", () => {
  it("projects only fixed names and ordinals while forwarding exact bytes", () => {
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const diagnostic = createBootstrapDiagnostic();
    const { bridge, receive, reply } = observerFixture();
    const original = bridge.attachCdpClientSocket;
    diagnostic.watchRelay(bridge);
    const send = vi.fn();
    const callbacks = bridge.attachCdpClientSocket({ send, close: vi.fn() });
    diagnostic.arm("private-selected", "private-unrelated");
    const command = JSON.stringify({
      id: 42,
      method: "Page.navigate",
      sessionId: "private-session",
      params: { url: "https://private.invalid", headers: { authorization: "private-credential" } },
    });
    callbacks.onMessage(command);
    const response = JSON.stringify({ id: 42, error: { message: "private-error" } });
    reply(response);
    reply(
      JSON.stringify({ method: "Runtime.consoleAPICalled", params: { args: ["private-content"] } }),
    );
    callbacks.onMessage("private-malformed");
    diagnostic.peer({ name: "private-peer", version: "private-version" });
    diagnostic.flush();
    expect(receive.mock.calls[0]).toEqual([command]);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual([response]);
    expect(send).toHaveBeenCalledTimes(2);
    const printed = String(output.mock.calls[0]?.[0]);
    expect(printed).not.toContain("private-");
    expect(printed).not.toContain("Runtime.consoleAPICalled");
    expect(printed).toContain('"method":"Page.navigate"');
    expect(printed).toContain('"error":true');
    diagnostic.dispose();
    expect(bridge.attachCdpClientSocket).toBe(original);
  });

  it("caps flood output but retains the action outcome and teardown", async () => {
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const diagnostic = createBootstrapDiagnostic();
    const { bridge, reply } = observerFixture();
    diagnostic.watchRelay(bridge);
    const callbacks = bridge.attachCdpClientSocket({ send: () => {}, close: () => {} });
    diagnostic.arm("selected", "unrelated");
    for (let index = 0; index < 1_000; index++) {
      reply(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: { requestId: `request-${index}` },
        }),
      );
    }
    diagnostic.mark("navigate.status", 500);
    diagnostic.flush();
    await callbacks.onClose();
    diagnostic.mark("relay.closed", true);
    diagnostic.flush();
    diagnostic.flush();
    const printed = output.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toHaveBeenCalledTimes(2);
    expect(printed.length).toBeLessThan(100_000);
    expect(printed).toContain('"phase":"navigate.status","value":500');
    expect(printed).toContain('"phase":"relay.closed","value":true');
    expect(printed).not.toContain('"dropped":0');
    diagnostic.dispose();
  });

  it("preserves a transport exception and ignores a diagnostic sink exception", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("sink");
    });
    const diagnostic = createBootstrapDiagnostic();
    const { bridge, receive } = observerFixture();
    diagnostic.watchRelay(bridge);
    const failure = new Error("transport");
    receive.mockImplementation(() => {
      throw failure;
    });
    const callbacks = bridge.attachCdpClientSocket({
      send: () => {
        throw failure;
      },
      close: () => {},
    });
    diagnostic.arm("selected", "unrelated");
    expect(() => callbacks.onMessage("malformed")).toThrow(failure);
    expect(() => diagnostic.flush()).not.toThrow();
    diagnostic.dispose();
  });
});
