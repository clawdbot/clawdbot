import fs from "node:fs";

const commandPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
const statusPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;

if (commandPath && statusPath) {
  const queueIds = new WeakMap();
  let nextQueueId = 1;
  let lastSeq = 0;
  let wrappedKey;
  let originalCallback;
  let heldOnce = false;
  let waitSeq;
  let gate;

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
  };

  const timer = setInterval(() => void tick(), 25);
  timer.unref?.();
}
