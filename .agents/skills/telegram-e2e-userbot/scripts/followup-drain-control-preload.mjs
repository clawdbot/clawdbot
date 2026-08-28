import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const commandPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
const statusPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;

if (commandPath && statusPath) {
  const queueIds = new WeakMap();
  let nextQueueId = 1;
  let lastSeq = 0;
  let wrappedKey;
  let originalCallback;
  let heldRun;
  let heldOnce = false;
  let waitSeq;
  let gate;
  let processing = false;

  const queueId = (queue) => {
    if (!queue) return null;
    let id = queueIds.get(queue);
    if (!id) {
      id = nextQueueId++;
      queueIds.set(queue, id);
    }
    return id;
  };
  const queueState = (key) => {
    const queue = globalThis[Symbol.for("openclaw.followupQueues")]?.get(key);
    return {
      queueId: queueId(queue),
      draining: queue?.draining ?? false,
      pending: queue ? Math.max(0, queue.items.length - queue.inFlight.size) : 0,
      inFlight: queue?.inFlight.size ?? 0,
    };
  };
  const writeStatus = (value) => {
    const pending = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(pending, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(pending, statusPath);
  };
  const readCommand = () => {
    try {
      return JSON.parse(fs.readFileSync(commandPath, "utf8"));
    } catch {
      return null;
    }
  };

  const tick = async () => {
    if (processing) return;
    const command = readCommand();
    if (!command || command.seq <= lastSeq) return;
    if (command.command === "arm") {
      const callbacks = globalThis[Symbol.for("openclaw.followupDrainCallbacks")];
      const callback = callbacks?.get(command.sessionKey);
      if (typeof callback !== "function") return;
      lastSeq = command.seq;
      wrappedKey = command.sessionKey;
      originalCallback = callback;
      gate = Promise.withResolvers();
      callbacks.set(command.sessionKey, async (run) => {
        if (!heldOnce) {
          heldOnce = true;
          heldRun = run;
          if (waitSeq) {
            writeStatus({
              seq: waitSeq,
              command: "waitHeld",
              status: "completed",
              ...queueState(wrappedKey),
            });
          }
          await gate.promise;
        }
        return originalCallback(run);
      });
      writeStatus({
        seq: command.seq,
        command: "arm",
        status: "completed",
        ...queueState(wrappedKey),
      });
      return;
    }
    if (!wrappedKey) return;
    lastSeq = command.seq;
    if (command.command === "waitHeld") {
      if (heldOnce) {
        writeStatus({
          seq: command.seq,
          command: "waitHeld",
          status: "completed",
          ...queueState(wrappedKey),
        });
      } else {
        waitSeq = command.seq;
      }
      return;
    }
    if (command.command === "release") {
      gate.resolve();
      writeStatus({
        seq: command.seq,
        command: "release",
        status: "completed",
        ...queueState(wrappedKey),
      });
      return;
    }
    if (command.command === "recover" && heldRun) {
      processing = true;
      const before = queueState(wrappedKey);
      try {
        const recoveryUrl = pathToFileURL(
          path.join(process.cwd(), "src/logging/diagnostic-stuck-session-recovery.runtime.ts"),
        );
        const { recoverStuckDiagnosticSession } = await import(recoveryUrl.href);
        const outcome = await recoverStuckDiagnosticSession({
          sessionId: heldRun.run.sessionId,
          sessionKey: wrappedKey,
          ageMs: 12 * 60_000,
          queueDepth: Math.max(1, before.pending),
          allowActiveAbort: true,
        });
        const after = queueState(wrappedKey);
        writeStatus({
          seq: command.seq,
          command: "recover",
          status: "completed",
          before,
          after,
          replaced: before.queueId !== after.queueId,
          recoveryStatus: outcome.status,
          recoveryAction: outcome.action,
        });
      } catch (error) {
        writeStatus({
          seq: command.seq,
          command: "recover",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        processing = false;
      }
    }
  };

  const timer = setInterval(() => void tick(), 25);
  timer.unref?.();
}
