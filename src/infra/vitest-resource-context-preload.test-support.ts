import type { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import {
  publishVitestResourceContext,
  resolveVitestResourceContext,
  VITEST_PAUSE_AFTER_ACK_RECEIPT,
} from "./vitest-resource-context.test-support.ts";

function installPauseAfterAcknowledgementProbe(receiptPath: string): void {
  const isVitestFork = (arg: unknown) =>
    typeof arg === "string" && arg.replaceAll("\\", "/").endsWith("/vitest/dist/workers/forks.js");
  if (isVitestFork(process.argv[1]) && process.send) {
    const processWithGenericSend = process as unknown as {
      send: (message: unknown, ...args: unknown[]) => boolean;
    };
    const send = processWithGenericSend.send;
    processWithGenericSend.send = function (message, ...args) {
      if (
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "__vitest_worker_response__") === true &&
        "type" in message &&
        message.type === "stopped" &&
        "willExit" in message &&
        message.willExit === true
      ) {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
        args[callbackIndex] = function (...callbackArgs: unknown[]) {
          if (!callbackArgs[0]) {
            process.kill(process.pid, "SIGSTOP");
          }
          return Reflect.apply(callback, this, callbackArgs);
        };
      }
      return send.call(this, message, ...args);
    };
  }
  subscribe("child_process", (event) => {
    if (
      typeof event !== "object" ||
      event === null ||
      !("process" in event) ||
      typeof event.process !== "object" ||
      event.process === null
    ) {
      return;
    }
    const child = event.process as ChildProcess;
    let selected = false;
    let acknowledged = false;
    let terminationScheduled = false;
    child.once("spawn", () => {
      selected = child.spawnargs.some(isVitestFork);
    });
    child.on("message", (message: unknown) => {
      if (
        selected &&
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "__vitest_worker_response__") === true &&
        "type" in message &&
        message.type === "stopped"
      ) {
        acknowledged = true;
        if (!terminationScheduled) {
          terminationScheduled = true;
          setTimeout(() => child.kill("SIGKILL"), 25).unref();
        }
      }
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (selected) {
        fs.writeFileSync(receiptPath, JSON.stringify({ acknowledged, code, signal }));
      }
    });
  });
}

publishVitestResourceContext(resolveVitestResourceContext(process.env));
const pauseAfterAckReceipt = process.env[VITEST_PAUSE_AFTER_ACK_RECEIPT];
if (pauseAfterAckReceipt && process.platform !== "win32") {
  installPauseAfterAcknowledgementProbe(pauseAfterAckReceipt);
}
