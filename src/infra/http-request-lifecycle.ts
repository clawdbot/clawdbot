// Owns HTTP rejection transport and per-connection request ordering.
import { channel } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import { createDeferredCore } from "../shared/deferred.js";

// This is a transport grace period, not another body-upload allowance. The
// request stays paused; Node's readable high-water mark bounds residual input.
const REJECTION_CLOSE_TIMEOUT_MS = 1_000;

type Rejection = {
  request: IncomingMessage;
  phase: "selected" | "writing" | "written" | "closed";
  closed: Promise<void>;
  destroy: () => void;
};

type HttpConnection = {
  requests: Set<() => void>;
  detach: () => void;
  rejection?: Rejection;
};

const connections = new WeakMap<Duplex, HttpConnection>();

function connectionFor(socket: Duplex): HttpConnection {
  const existing = connections.get(socket);
  if (existing) {
    return existing;
  }
  const requests = new Set<() => void>();
  const connection: HttpConnection = {
    requests,
    detach: () => {
      socket.off("resume", pauseQueuedInput);
      socket.off("close", onClose);
    },
  };
  connections.set(socket, connection);
  const pauseQueuedInput = () => {
    const phase = connection.rejection?.phase;
    if (
      requests.size > 1 ||
      phase === "selected" ||
      phase === "writing" ||
      connection.rejection?.request.complete
    ) {
      socket.pause();
    }
  };
  // Node resumes input after parsing each message. Reapply backpressure at
  // that event so queued admission retains at most the current read batch.
  socket.on("resume", pauseQueuedInput);
  const onClose = () => {
    connection.detach();
    for (const resume of requests) {
      resume();
    }
  };
  socket.once("close", onClose);
  return connection;
}

/** Closing is selected before any ordered response write can reach the socket. */
export function isHttpConnectionClosing(socket: Duplex): boolean {
  return socket.destroyed || socket.writableEnded || Boolean(connections.get(socket)?.rejection);
}

/**
 * Serialize application admission, not Node's response writes. A later request
 * must not cross async routing/auth while an earlier body can still be rejected.
 * Already admitted work finishes; queued work is never dispatched after closure.
 */
export async function runHttpConnectionRequest(
  req: IncomingMessage,
  run: () => Promise<void>,
  response?: ServerResponse | "upgrade",
): Promise<void> {
  const socket = req.socket;
  if (isHttpConnectionClosing(socket)) {
    socket.pause();
    return;
  }
  const connection = connectionFor(socket);
  const queued = connection.requests.size > 0;
  const ready = createDeferredCore();
  connection.requests.add(ready.resolve);
  try {
    if (queued) {
      socket.pause();
      await ready.promise;
    }
    if (!isHttpConnectionClosing(socket)) {
      if (response === "upgrade") {
        // The preceding HTTP response released queue-owned backpressure before
        // admission. From this point the upgrade owner controls all socket flow.
        connection.requests.delete(ready.resolve);
        connection.detach();
        connections.delete(socket);
        return await run();
      }
      await run();
      const res = response;
      if (res && !res.writableFinished && !res.destroyed && !socket.destroyed) {
        const responseDone = createDeferredCore();
        res.once("finish", responseDone.resolve);
        res.once("close", responseDone.resolve);
        socket.once("close", responseDone.resolve);
        await responseDone.promise;
        res.off("finish", responseDone.resolve);
        res.off("close", responseDone.resolve);
        socket.off("close", responseDone.resolve);
      }
    }
  } finally {
    if (connections.get(socket) === connection) {
      connection.requests.delete(ready.resolve);
      if (connection.requests.size <= 1 && !isHttpConnectionClosing(socket)) {
        socket.resume();
      }
      connection.requests.values().next().value?.();
    }
  }
}

/** Keep security/CORS headers, but discard metadata for an abandoned representation. */
export function clearHttpResponseRepresentationHeaders(res: ServerResponse): void {
  for (const header of [
    "Content-Encoding",
    "Content-Disposition",
    "Content-Range",
    "Content-Language",
    "Content-Location",
    "Content-Type",
    "ETag",
    "Last-Modified",
    "Transfer-Encoding",
    "Trailer",
  ]) {
    res.removeHeader(header);
  }
}

/** Fence synchronously at the byte/time limit, before a reader rejects its promise. */
export function selectHttpRequestRejection(req: IncomingMessage): Rejection {
  const socket = req.socket;
  const connection = connectionFor(socket);
  if (connection.rejection) {
    return connection.rejection;
  }
  const completion = createDeferredCore();
  const rejection: Rejection = {
    request: req,
    phase: "selected",
    closed: completion.promise,
    destroy: () => socket.destroy(),
  };
  connection.rejection = rejection;
  for (const resume of connection.requests) {
    resume();
  }
  req.pause();
  socket.pause();
  // A completed request no longer provides body backpressure. Do not let its
  // parser consume an arbitrary pipeline during the half-close grace period.
  const pauseCompletedRequest = () => {
    if (req.complete) {
      socket.pause();
    }
  };
  req.on("readable", pauseCompletedRequest);
  const timer = setTimeout(rejection.destroy, REJECTION_CLOSE_TIMEOUT_MS);
  timer.unref();
  const onClose = () => {
    rejection.phase = "closed";
    clearTimeout(timer);
    req.off("error", rejection.destroy);
    req.off("readable", pauseCompletedRequest);
    socket.off("error", rejection.destroy);
    completion.resolve();
  };
  req.on("error", rejection.destroy);
  socket.on("error", rejection.destroy);
  socket.once("close", onClose);
  if (socket.destroyed) {
    socket.off("close", onClose);
    onClose();
  }
  return rejection;
}

/** Preserve the caller's error representation and security headers until half-close. */
export async function sendHttpRequestRejection(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType?: string,
): Promise<void> {
  const rejection = selectHttpRequestRejection(req);
  if (rejection.request !== req || rejection.phase !== "selected") {
    return await rejection.closed;
  }
  if (res.headersSent || res.destroyed || res.writableEnded) {
    // Ending a committed chunked response would falsely complete a partial body.
    rejection.destroy();
    return await rejection.closed;
  }
  const socket = req.socket;
  const onResponseClose = () => {
    rejection.destroy();
  };
  res.on("error", rejection.destroy);
  res.once("close", onResponseClose);
  let stopWaitingForSocket: (() => void) | undefined;
  try {
    rejection.phase = "writing";
    res.statusCode = statusCode;
    clearHttpResponseRepresentationHeaders(res);
    res.setHeader("Connection", "close");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    // res.end() invokes Node's destroySoon on Connection: close. Write the
    // entire framed response, then half-close only after its ordered callback.
    const onWritten = (error?: Error | null) => {
      if (error) {
        rejection.destroy();
      } else if (rejection.phase === "writing") {
        rejection.phase = "written";
        try {
          socket.end();
          // Do not resume application body consumers after rejection. Reading
          // the socket alone lets Node buffer only up to request backpressure.
          socket.resume();
        } catch {
          rejection.destroy();
        }
      }
    };
    if (process.versions.bun) {
      // Bun's native HTTP response owns framing/closure; raw socket.end() does
      // not flush that response and Bun emits no HTTP finish diagnostics event.
      // Unlike Node's destroySoon path, use its ordered native end operation.
      res.end(body, () => {
        if (rejection.phase === "writing") {
          rejection.phase = "written";
        }
      });
    } else if (req.method === "HEAD") {
      const writeHeaders = () => {
        if (!res.socket || rejection.phase !== "writing") {
          return;
        }
        stopWaitingForSocket?.();
        try {
          res.flushHeaders();
          res.socket.write("", onWritten);
        } catch {
          rejection.destroy();
        }
      };
      if (!res.socket) {
        // HEAD ignores write callbacks. The public finish notification lets a
        // standalone SDK response wait for earlier responses without private
        // socket-assignment events; Node completes that handoff on this stack.
        const finished = channel("http.server.response.finish");
        const onFinish = (message: unknown) => {
          // SAFETY: Node documents this channel's payload as including the response's socket.
          if ((message as { socket: Duplex }).socket === socket) {
            queueMicrotask(writeHeaders);
          }
        };
        finished.subscribe(onFinish);
        stopWaitingForSocket = () => finished.unsubscribe(onFinish);
      }
      writeHeaders();
    } else {
      res.write(body, onWritten);
    }
  } catch {
    rejection.destroy();
  }
  await rejection.closed;
  stopWaitingForSocket?.();
  res.off("error", rejection.destroy);
  res.off("close", onResponseClose);
}

/** Release handler/limiter ownership only after the selected transport closes. */
export function waitForHttpRequestRejection(req: IncomingMessage): Promise<void> | undefined {
  return connections.get(req.socket)?.rejection?.closed;
}
