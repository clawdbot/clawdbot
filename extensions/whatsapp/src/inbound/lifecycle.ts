type Listener = (...args: unknown[]) => void;

type OffCapableEmitter = {
  on: (event: string, listener: Listener) => void;
  off?: (event: string, listener: Listener) => void;
  removeListener?: (event: string, listener: Listener) => void;
};

type ClosableSocket = {
  ws?: {
    close?: () => void;
  };
};

export function attachEmitterListener(
  emitter: OffCapableEmitter,
  event: string,
  listener: Listener,
): () => void {
  emitter.on(event, listener);
  return () => {
    if (typeof emitter.off === "function") {
      emitter.off(event, listener);
      return;
    }
    if (typeof emitter.removeListener === "function") {
      emitter.removeListener(event, listener);
    }
  };
}

export function closeInboundMonitorSocket(sock: ClosableSocket): void {
  sock.ws?.close?.();
}
