import { WebSocket } from "ws";

/** Keep idle transports active; only the connection owner may impose a pong deadline. */
export function startWebSocketKeepalive(socket: WebSocket, onMissedPong?: () => void): () => void {
  let awaitingPong = false;
  const onPong = () => {
    awaitingPong = false;
  };
  const stop = () => {
    clearInterval(timer);
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  socket.on("pong", onPong);
  socket.once("close", stop);
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    // Stream peers can pause reads for backpressure, delaying automatic pongs.
    // Their existing control connection and stream owner still govern revocation.
    if (awaitingPong && onMissedPong) {
      onMissedPong();
      return;
    }
    awaitingPong = true;
    try {
      socket.ping();
    } catch {
      // The socket owner handles transport failure and closes the connection.
    }
  }, 25_000);
  return stop;
}
