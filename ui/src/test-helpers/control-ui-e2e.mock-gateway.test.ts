/* @vitest-environment jsdom */
// Exercises the serialized mock gateway exactly as a page would: the init
// script installs MockWebSocket on window, and requests flow over it.
import { describe, expect, it } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";

type ResponseFrame = { id?: string; type?: string; payload?: Record<string, unknown> };

function flushMockTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("mock gateway stateful config", () => {
  it("round-trips config.set through config.get with an advancing hash", async () => {
    const raw = '{\n  "logging": {\n    "level": "info"\n  }\n}\n';
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: { logging: { level: "info" } },
          hash: "fixture-hash",
          valid: true,
          issues: [],
        },
      },
    });
    // Execute the generated init script the way the browser <script> tag does.
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    const request = async (id: string, method: string, params: unknown) => {
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      await flushMockTimers();
      const response = frames.find((frame) => frame.type === "res" && frame.id === id);
      if (!response) {
        throw new Error(`No mock response for ${method}`);
      }
      return response.payload as Record<string, unknown>;
    };

    const initial = await request("get-1", "config.get", {});
    expect(initial).toMatchObject({
      raw,
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-hash",
    });
    expect(initial.config).toEqual({ logging: { level: "info" } });

    const nextRaw = raw.replace("info", "debug");
    const set = await request("set-1", "config.set", {
      raw: nextRaw,
      baseHash: "fixture-hash",
    });
    // Acks carry the persisted hash, mirroring the real gateway contract.
    expect(set).toEqual({ ok: true, hash: "mock-config-hash-1" });

    const reloaded = await request("get-2", "config.get", {});
    expect(reloaded).toMatchObject({
      raw: nextRaw,
      hash: "mock-config-hash-1",
      configRevisionHash: "mock-config-hash-1",
      appliedConfigHash: "fixture-hash",
    });
    expect(reloaded.config).toEqual({ logging: { level: "debug" } });

    const applied = await request("apply-1", "config.apply", {
      raw: nextRaw,
      baseHash: "mock-config-hash-1",
    });
    expect(applied).toEqual({ ok: true, hash: "mock-config-hash-2" });
    expect(await request("get-3", "config.get", {})).toMatchObject({
      hash: "mock-config-hash-2",
      configRevisionHash: "mock-config-hash-2",
      appliedConfigHash: "mock-config-hash-2",
    });

    socket.close();
  });

  it("leaves config methods untouched when the scenario has no raw fixture", async () => {
    const script = createControlUiMockGatewayInitScript({
      methodResponses: { "config.set": { custom: true } },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(JSON.stringify({ type: "req", id: "set-1", method: "config.set", params: {} }));
    await flushMockTimers();
    const response = frames.find((frame) => frame.type === "res" && frame.id === "set-1");
    expect(response?.payload).toEqual({ custom: true });
    socket.close();
  });

  it("hydrates legacy persisted config state without losing revision hashes", async () => {
    const raw = '{"logging":{"level":"info"}}';
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: { logging: { level: "info" } },
          hash: "fixture-hash",
          appliedConfigHash: "fixture-applied-hash",
          valid: true,
          issues: [],
        },
      },
    });
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "openclaw.control-ui-e2e.configState",
      JSON.stringify({ raw, revision: 2 }),
    );
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();
    socket.send(JSON.stringify({ type: "req", id: "get-1", method: "config.get", params: {} }));
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "get-1")?.payload).toMatchObject({
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-applied-hash",
    });
    socket.close();
  });
});
