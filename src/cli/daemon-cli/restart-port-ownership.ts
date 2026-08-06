import type { PortUsage } from "../../infra/ports.js";

export function hasListenerAttributionGap(portUsage: PortUsage): boolean {
  // lsof/netstat may report a busy port without a PID; keep that distinct from a free port.
  if (portUsage.status !== "busy" || portUsage.listeners.length > 0) {
    return false;
  }
  if (portUsage.errors?.length) {
    return true;
  }
  return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}

export function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}

export function allListenersOwnedByRuntimePid(
  listeners: PortUsage["listeners"],
  runtimePid: number,
): boolean {
  return (
    listeners.length > 0 &&
    listeners.every((listener) => listenerOwnedByRuntimePid({ listener, runtimePid }))
  );
}
