// Gateway HTTP server listen helper with retry and lock-aware errors.
import type { Server as HttpServer } from "node:http";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

const EADDRINUSE_MAX_RETRIES = 20;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;

async function closeServerQuietly(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Listen on the configured gateway host/port, retrying transient EADDRINUSE windows. */
export async function listenGatewayHttpServer(params: {
  httpServer: HttpServer;
  bindHost: string;
  port: number;
  retryEaddrinuse?: boolean;
  serviceName?: string;
  endpointScheme?: "http" | "https" | "ws" | "wss";
}) {
  const {
    httpServer,
    bindHost,
    port,
    retryEaddrinuse = true,
    serviceName = "gateway",
    endpointScheme = "ws",
  } = params;
  const maxRetries = retryEaddrinuse ? EADDRINUSE_MAX_RETRIES : 0;

  for (const attempt of Array.from({ length: maxRetries + 1 }, (_, index) => index)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, bindHost);
      });
      return; // bound successfully
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < maxRetries) {
        // Port may still be in TIME_WAIT after a recent process exit; retry.
        await closeServerQuietly(httpServer);
        await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
        continue;
      }
      if (code === "EADDRINUSE") {
        throw new GatewayLockError(
          `another ${serviceName} instance is already listening on ${endpointScheme}://${bindHost}:${port}`,
          err,
        );
      }
      throw new GatewayLockError(
        `failed to bind ${serviceName} socket on ${endpointScheme}://${bindHost}:${port}: ${String(err)}`,
        err,
      );
    }
  }
}
