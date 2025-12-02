/**
 * IPC server for warelay relay.
 *
 * When the relay is running, it starts a Unix socket server that allows
 * `warelay send` and `warelay heartbeat` to send messages through the
 * existing WhatsApp connection instead of creating new ones.
 *
 * This prevents Signal session ratchet corruption from multiple connections.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { getChildLogger } from "../logging.js";

const SOCKET_DIR = path.join(os.homedir(), ".warelay", "ipc");
const SOCKET_PATH = path.join(SOCKET_DIR, "relay.sock");

export interface IpcSendRequest {
  type: "send";
  to: string;
  message: string;
  mediaUrl?: string;
}

export interface IpcSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

type SendHandler = (
  to: string,
  message: string,
  mediaUrl?: string,
) => Promise<{ messageId: string }>;

let server: net.Server | null = null;

/**
 * Start the IPC server. Called by the relay when it starts.
 */
export function startIpcServer(sendHandler: SendHandler): void {
  const logger = getChildLogger({ module: "ipc-server" });

  ensureSocketDir();
  try {
    assertSafeSocketPath(SOCKET_PATH);
  } catch (err) {
    logger.error({ error: String(err) }, "Refusing to start IPC server");
    throw err;
  }

  // Clean up stale socket file (only if safe to do so)
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  server = net.createServer((conn) => {
    let buffer = "";

    conn.on("data", async (data) => {
      buffer += data.toString();

      // Try to parse complete JSON messages (newline-delimited)
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const request = JSON.parse(line) as IpcSendRequest;

          if (request.type === "send") {
            try {
              const result = await sendHandler(
                request.to,
                request.message,
                request.mediaUrl,
              );
              const response: IpcSendResponse = {
                success: true,
                messageId: result.messageId,
              };
              conn.write(`${JSON.stringify(response)}\n`);
            } catch (err) {
              const response: IpcSendResponse = {
                success: false,
                error: String(err),
              };
              conn.write(`${JSON.stringify(response)}\n`);
            }
          }
        } catch (err) {
          logger.warn({ error: String(err) }, "failed to parse IPC request");
          const response: IpcSendResponse = {
            success: false,
            error: "Invalid request format",
          };
          conn.write(`${JSON.stringify(response)}\n`);
        }
      }
    });

    conn.on("error", (err) => {
      logger.debug({ error: String(err) }, "IPC connection error");
    });
  });

  server.listen(SOCKET_PATH, () => {
    logger.info({ socketPath: SOCKET_PATH }, "IPC server started");
    // Make socket accessible
    fs.chmodSync(SOCKET_PATH, 0o600);
  });

  server.on("error", (err) => {
    logger.error({ error: String(err) }, "IPC server error");
  });
}

/**
 * Stop the IPC server. Called when relay shuts down.
 */
export function stopIpcServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // Ignore
  }
}

/**
 * Check if the relay IPC server is running.
 */
export function isRelayRunning(): boolean {
  try {
    assertSafeSocketPath(SOCKET_PATH);
    fs.accessSync(SOCKET_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a message through the running relay's IPC.
 * Returns null if relay is not running.
 */
export async function sendViaIpc(
  to: string,
  message: string,
  mediaUrl?: string,
): Promise<IpcSendResponse | null> {
  if (!isRelayRunning()) {
    return null;
  }

  return new Promise((resolve) => {
    const client = net.createConnection(SOCKET_PATH);
    let buffer = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve({ success: false, error: "IPC timeout" });
      }
    }, 30000); // 30 second timeout

    client.on("connect", () => {
      const request: IpcSendRequest = {
        type: "send",
        to,
        message,
        mediaUrl,
      };
      client.write(`${JSON.stringify(request)}\n`);
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as IpcSendResponse;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            client.end();
            resolve(response);
          }
          return;
        } catch {
          // Keep reading
        }
      }
    });

    client.on("error", (_err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Socket exists but can't connect - relay might have crashed
        resolve(null);
      }
    });

    client.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ success: false, error: "Connection closed" });
      }
    });
  });
}

/**
 * Get the IPC socket path for debugging/status.
 */
export function getSocketPath(): string {
  return SOCKET_PATH;
}

function ensureSocketDir(): void {
  try {
    const stat = fs.lstatSync(SOCKET_DIR);
    if (stat.isSymbolicLink()) {
      throw new Error(`IPC dir is a symlink: ${SOCKET_DIR}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`IPC dir is not a directory: ${SOCKET_DIR}`);
    }
    // Enforce private permissions
    fs.chmodSync(SOCKET_DIR, 0o700);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`IPC dir owned by different user: ${SOCKET_DIR}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
      return;
    }
    throw err;
  }
}

function assertSafeSocketPath(socketPath: string): void {
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing IPC socket symlink: ${socketPath}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`IPC socket owned by different user: ${socketPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // Missing is fine; creation will happen next.
    }
    throw err;
  }
}
