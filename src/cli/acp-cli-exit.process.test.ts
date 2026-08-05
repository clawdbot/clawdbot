// Process regression coverage for ACP help commands returning without loading runtime transports.
import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type RawData, WebSocketServer } from "ws";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const execFileAsync = promisify(execFile);
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

const INITIALIZE_FRAME = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  },
};

async function createPreparedAcpProcessState() {
  const state = await createOpenClawTestState({
    applyEnv: false,
    label: "acp-process",
    scenario: "minimal",
  });
  try {
    // These cases assert bridge stderr after normal startup. Prepare canonical
    // shared state so the one-time migration diagnostic is not part of that signal.
    const database = openOpenClawStateDatabase({ env: state.env });
    closeOpenClawStateDatabaseByPath(database.path);
    return state;
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}

function createAcpProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    NODE_ENV: undefined,
    NODE_OPTIONS: "--use-openssl-ca",
    NODE_USE_SYSTEM_CA: "0",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    VITEST: undefined,
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function waitForJsonLine(child: ChildProcessWithoutNullStreams, id: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for ACP response")),
      CHILD_PROCESS_TIMEOUT_MS,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`ACP process exited before response (code=${code}, signal=${signal})`));
    };
    const finish = (response: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(response);
    };

    child.once("exit", onExit);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.id === id) {
          finish(response);
          return;
        }
      }
    });
  });
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

describe("ACP CLI process exit", () => {
  it.each([
    { args: ["acp", "--help"], usage: "Usage: openclaw acp [options] [command]" },
    { args: ["acp", "client", "--help"], usage: "Usage: openclaw acp client [options]" },
  ])(
    "exits promptly after $args",
    async ({ args, usage }) => {
      const state = await createPreparedAcpProcessState();
      try {
        const result = await execFileAsync(
          process.execPath,
          ["--import", "tsx", "src/entry.ts", ...args],
          {
            cwd: path.resolve("."),
            encoding: "utf8",
            env: {
              ...createAcpProcessEnv(state.env),
              NODE_OPTIONS: process.platform === "darwin" ? "--use-system-ca" : undefined,
              NODE_USE_SYSTEM_CA: undefined,
            },
            killSignal: "SIGKILL",
            timeout: CHILD_PROCESS_TIMEOUT_MS,
          },
        );

        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(usage);
      } finally {
        await state.cleanup();
      }
    },
    CHILD_PROCESS_TIMEOUT_MS + 5_000,
  );

  it.each([
    { name: "empty stdin", input: "" },
    {
      name: "an initialize frame",
      input: `${JSON.stringify(INITIALIZE_FRAME)}\n`,
    },
  ])("exits when the bridge starts with $name and the client disconnects", async ({ input }) => {
    const state = await createPreparedAcpProcessState();
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/entry.ts", "acp", "--require-existing"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: createAcpProcessEnv(state.env),
          input,
          killSignal: "SIGKILL",
          timeout: CHILD_PROCESS_TIMEOUT_MS,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      await state.cleanup();
    }
  });

  it("processes an initialize frame buffered before Gateway hello", async () => {
    const state = await createPreparedAcpProcessState();
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      wss.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            seq: 1,
            payload: { nonce: "acp-process-test", ts: Date.now() },
          }),
        );
        socket.on("message", (data) => {
          const frame = JSON.parse(rawDataToText(data)) as { id: string; method: string };
          if (frame.method !== "connect") {
            return;
          }
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "acp-process-test", connId: "acp-process-test" },
                features: { methods: [], events: [] },
                snapshot: {
                  presence: [],
                  health: {},
                  stateVersion: { presence: 1, health: 1 },
                  uptimeMs: 1,
                },
                auth: { role: "operator", scopes: ["operator.admin"] },
                policy: {
                  maxPayload: 512 * 1024,
                  maxBufferedBytes: 1024 * 1024,
                  tickIntervalMs: 1000,
                },
              },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("ACP process test Gateway did not get a TCP address");
      }

      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/entry.ts",
          "acp",
          "--require-existing",
          "--url",
          `ws://127.0.0.1:${address.port}`,
        ],
        {
          cwd: path.resolve("."),
          env: createAcpProcessEnv(state.env),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitPromise = waitForExit(child);
      const responsePromise = waitForJsonLine(child, INITIALIZE_FRAME.id);

      // Write before the Gateway handshake completes. Startup monitoring must
      // retain this frame for the eventual AgentSideConnection reader.
      child.stdin.write(`${JSON.stringify(INITIALIZE_FRAME)}\n`);
      const response = await responsePromise;
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: INITIALIZE_FRAME.id,
        result: { protocolVersion: INITIALIZE_FRAME.params.protocolVersion },
      });

      child.stdin.end();
      const exit = await exitPromise;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
    } finally {
      child?.kill("SIGKILL");
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await state.cleanup();
    }
  }, 40_000);
});
