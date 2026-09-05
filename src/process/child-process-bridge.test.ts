import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachChildProcessBridge } from "./child-process-bridge.js";

describe("attachChildProcessBridge", () => {
  it.each(["exit", "close"] as const)(
    "keeps forwarding after operational errors until child %s",
    (terminalEvent) => {
      const signal: NodeJS.Signals = "SIGTERM";
      const existingListeners = new Set(process.listeners(signal));
      const kill = vi.fn(() => true);
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        kill,
      }) as unknown as ChildProcess;
      child.on("error", () => {});

      const { detach } = attachChildProcessBridge(child, { signals: [signal] });
      const signalListener = process
        .listeners(signal)
        .find((listener) => !existingListeners.has(listener));

      try {
        expect(signalListener).toBeDefined();
        child.emit("error", new Error("signal delivery failed"));
        expect(process.listeners(signal)).toContain(signalListener);

        signalListener?.(signal);
        expect(kill).toHaveBeenCalledWith(signal);

        child.emit(terminalEvent, 0, null);
        expect(process.listeners(signal)).not.toContain(signalListener);
      } finally {
        detach();
      }
    },
  );
});
