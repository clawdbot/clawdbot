import type { WebSocket } from "ws";
import type { AuthRateLimiter } from "../auth-rate-limit.js";

export type PublicWorkerIngressContext = {
  clientIp: string | undefined;
  rateLimiter: AuthRateLimiter | undefined;
};

const publicWorkerIngressContexts = new WeakMap<WebSocket, PublicWorkerIngressContext>();

/** Carry route-authenticated public ingress facts into the shared connection owner. */
export function markPublicWorkerIngress(
  socket: WebSocket,
  context: PublicWorkerIngressContext,
): void {
  publicWorkerIngressContexts.set(socket, context);
}

export function takePublicWorkerIngress(socket: WebSocket): PublicWorkerIngressContext | undefined {
  const context = publicWorkerIngressContexts.get(socket);
  publicWorkerIngressContexts.delete(socket);
  return context;
}
