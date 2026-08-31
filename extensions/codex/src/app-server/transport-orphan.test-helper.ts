import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(import.meta.url);
if (process.argv[2] === "child") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  process.stdout.write(`${JSON.stringify({ child: process.pid, descendant: descendant.pid })}\n`);
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const { createStdioTransport } = await import("./transport-stdio.js");
  if (process.argv[2] === "native") {
    const command = process.argv[4]!;
    const cwd = process.argv[5]!;
    const child = await createStdioTransport(
      {
        transport: "stdio",
        command,
        args: ["app-server", "--listen", "stdio://"],
        cwd,
        headers: {},
      },
      process.env,
    );
    child.stderr.pipe(process.stderr);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      // SAFETY: The pinned native test binary emits Codex JSON-RPC envelopes on stdout.
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        error?: unknown;
        params: { deltaBase64: string };
      };
      if (message.error) {
        throw new Error(JSON.stringify(message.error));
      }
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)",
            ],
            processId: "orphan-proof",
            streamStdoutStderr: true,
            disableTimeout: true,
            sandboxPolicy: { type: "dangerFullAccess" },
            cwd,
          },
        });
      } else if (message.method === "command/exec/outputDelta") {
        const descendant = Number(
          Buffer.from(message.params.deltaBase64, "base64").toString().trim(),
        );
        if (Number.isSafeInteger(descendant) && descendant > 0) {
          process.stdout.write(
            `${JSON.stringify({ parent: process.pid, child: child.pid, descendant })}\n`,
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "openclaw_orphan_test", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  } else {
    const child = await createStdioTransport({
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, "child"],
      headers: {},
    });
    child.stderr.pipe(process.stderr);
    createInterface({ input: child.stdout }).once("line", (line) => {
      process.stdout.write(`${JSON.stringify({ parent: process.pid, ...JSON.parse(line) })}\n`);
    });
    child.once("error", (error) => {
      throw error;
    });
  }
}
