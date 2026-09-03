// ACPX tests protect the lazy proxy contract: every hook forwards to the
// resolved runtime, and an absent hook fails loudly instead of fabricating
// success (regression for silently no-op doctor/status/prepareFreshSession).
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent } from "../runtime-api.js";
import { createLazyAcpRuntimeProxy, type CompleteAcpRuntime } from "./runtime-proxy.js";

const handle = {
  sessionKey: "agent:main:acp:test",
  backend: "acpx",
  runtimeSessionName: "acp:test",
};

function createCompleteRuntime(promptStarted: Promise<void> = Promise.resolve()) {
  const startTurn = vi.fn((input: { requestId: string }) => ({
    requestId: input.requestId,
    promptStarted,
    events: (async function* (): AsyncGenerator<AcpRuntimeEvent> {})(),
    result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
  }));
  const prepareFreshSession = vi.fn(async () => {});
  const runtime: CompleteAcpRuntime = {
    ensureSession: vi.fn(async () => handle),
    startTurn,
    async *runTurn() {},
    getCapabilities: vi.fn(async () => ({ controls: ["session/status" as const] })),
    getStatus: vi.fn(async () => ({ summary: "live" })),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    doctor: vi.fn(async () => ({ ok: false, code: "MISSING_CLI", message: "acpx not installed" })),
    prepareFreshSession,
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { runtime, startTurn, prepareFreshSession };
}

describe("createLazyAcpRuntimeProxy", () => {
  it("forwards every hook to the resolved runtime without rewriting results", async () => {
    const promptStarted = createDeferred<void>();
    const { runtime, startTurn, prepareFreshSession } = createCompleteRuntime(
      promptStarted.promise,
    );
    const proxy = createLazyAcpRuntimeProxy(async () => runtime);
    const accepted = { configOptions: [{ id: "effort", currentValue: "medium" }] };
    runtime.setConfigOption = vi.fn(async () => accepted);
    await expect(proxy.setConfigOption({ handle, key: "effort", value: "high" })).resolves.toBe(
      accepted,
    );

    await expect(proxy.doctor()).resolves.toEqual({
      ok: false,
      code: "MISSING_CLI",
      message: "acpx not installed",
    });
    await expect(proxy.getStatus({ handle })).resolves.toEqual({ summary: "live" });
    await expect(proxy.getCapabilities({ handle })).resolves.toEqual({
      controls: ["session/status"],
    });
    await proxy.prepareFreshSession({ sessionKey: handle.sessionKey });
    expect(prepareFreshSession).toHaveBeenCalledWith({ sessionKey: handle.sessionKey });
    const turn = proxy.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "turn-1",
    });
    expect(turn.promptStarted).toBeDefined();
    let submitted = false;
    const observedPromptStarted = turn.promptStarted.then(() => {
      submitted = true;
    });
    await expect(turn.result).resolves.toEqual({ status: "completed", stopReason: "end_turn" });
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observedPromptStarted;
    expect(submitted).toBe(true);
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("fails loudly instead of fabricating success when a resolved runtime is missing hooks", async () => {
    // Contract-violating runtime only reachable by bypassing the type system.
    const incomplete = {
      ensureSession: vi.fn(async () => handle),
      async *runTurn() {},
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as CompleteAcpRuntime;
    const proxy = createLazyAcpRuntimeProxy(async () => incomplete);

    // Pre-fix the proxy fabricated `{ ok: true }` / `{}` / silent no-ops here.
    await expect(proxy.doctor()).rejects.toThrow();
    await expect(proxy.getStatus({ handle })).rejects.toThrow();
    await expect(proxy.getCapabilities({ handle })).rejects.toThrow();
    await expect(proxy.prepareFreshSession({ sessionKey: handle.sessionKey })).rejects.toThrow();
    await expect(proxy.setMode({ handle, mode: "auto" })).rejects.toThrow();
    await expect(
      proxy.setConfigOption({ handle, key: "model", value: "sonnet-4.6" }),
    ).rejects.toThrow();
  });
});
