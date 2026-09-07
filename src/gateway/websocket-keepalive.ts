export type WebSocketKeepaliveSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  ping(data?: undefined, mask?: undefined, callback?: (error?: Error) => void): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong" | "close", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  terminate(): void;
};

type PingWrite = { pingWriteState: "pending" | "completed" | "failed" };
export type WebSocketHeartbeatDiagnostics = PingWrite & {
  lastPongAgeMs: number | undefined;
  bufferedBytes: number;
};

/** Keep idle transports active; only the connection owner may impose a pong deadline. */
export function startWebSocketKeepalive(
  socket: WebSocketKeepaliveSocket,
  onMissedPong?: (diagnostics: WebSocketHeartbeatDiagnostics) => void,
): () => void {
  let awaitingPong: PingWrite | undefined;
  let lastPongAt: number | undefined;
  const onPong = () => {
    awaitingPong = undefined;
    if (onMissedPong) {
      lastPongAt = performance.now();
    }
  };
  const stop = () => {
    clearInterval(timer);
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  socket.on("pong", onPong);
  socket.once("close", stop);
  const timer = setInterval(() => {
    if (socket.readyState !== 1 /* OPEN */) {
      stop();
      return;
    }
    // Stream peers can pause reads for backpressure, delaying automatic pongs.
    // Their existing control connection and stream owner still govern revocation.
    if (awaitingPong && onMissedPong) {
      // Copy before termination can settle writes. Callback completion proves
      // local writing, not peer receipt; a pending callback does not prove unsent bytes.
      onMissedPong({
        ...awaitingPong,
        lastPongAgeMs: lastPongAt === undefined ? undefined : performance.now() - lastPongAt,
        bufferedBytes: socket.bufferedAmount,
      });
      return;
    }
    const attempt: PingWrite = { pingWriteState: "pending" };
    awaitingPong = attempt;
    try {
      socket.ping(
        undefined,
        undefined,
        onMissedPong
          ? (error) => {
              // A late completion belongs to this attempt, never a later ping.
              attempt.pingWriteState = error ? "failed" : "completed";
            }
          : undefined,
      );
    } catch {
      attempt.pingWriteState = "failed";
      // The socket owner handles transport failure and closes the connection.
    }
  }, 25_000);
  return stop;
}
