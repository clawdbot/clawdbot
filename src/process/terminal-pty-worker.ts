import { decodeTerminalPtyControl, type TerminalPtyEvent } from "./terminal-pty-protocol.js";
import { spawnTerminalPty, type TerminalPtyHandle } from "./terminal-pty.js";

let pty: TerminalPtyHandle | undefined;
let starting = false;
let parentLost = false;
let finished = false;

function report(message: TerminalPtyEvent, done?: () => void): void {
  if (!process.connected) {
    done?.();
    return;
  }
  process.send?.(message, () => done?.());
}

function finish(message: TerminalPtyEvent): void {
  if (finished) {
    return;
  }
  finished = true;
  pty?.kill();
  process.stdout.end(() => {
    report(message, () => {
      if (process.connected) {
        process.disconnect?.();
      }
    });
  });
}

function close(): void {
  parentLost = true;
  pty?.kill();
}

process.once("disconnect", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
process.stdout.on("error", close);
process.stdout.on("drain", () => pty?.resume());
process.on("message", (raw: unknown) => {
  const message = decodeTerminalPtyControl(raw);
  if (!message) {
    finish({ type: "error", message: "Invalid terminal host message" });
    return;
  }
  if (message.type === "start") {
    if (starting || parentLost) {
      return;
    }
    starting = true;
    if (process.versions.bun) {
      finish({
        type: "error",
        message: "Terminal worker requires Node; PATH resolves node to Bun.",
      });
      return;
    }
    void spawnTerminalPty(message.params).then(
      (handle) => {
        pty = handle;
        pty.onData((data) => {
          if (!process.stdout.write(data)) {
            handle.pause();
          }
        });
        pty.onExit((event) => finish({ type: "exit", ...event }));
        if (parentLost || finished) {
          pty.kill();
        } else {
          report({ type: "ready", pid: pty.pid });
        }
      },
      (error: unknown) =>
        finish({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (message.type === "input") {
    pty?.write(message.data);
  } else if (message.type === "resize") {
    pty?.resize(message.cols, message.rows);
  } else {
    pty?.kill(message.signal);
  }
});

// A source loader can yield before installing the IPC listener; admit starts only now.
report({ type: "boot" });
