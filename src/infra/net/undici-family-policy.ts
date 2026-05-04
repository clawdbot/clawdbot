import * as net from "node:net";
import { isWSL2Sync } from "../wsl.js";

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

export function resolveUndiciAutoSelectFamily(): boolean | undefined {
  if (typeof net.getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    const systemDefault = net.getDefaultAutoSelectFamily();
    // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to force
    // IPv4 connections and avoid fetch failures when reaching Windows-host services.
    if (systemDefault && isWSL2Sync()) {
      return false;
    }
    return systemDefault;
  } catch {
    return undefined;
  }
}

export function createUndiciAutoSelectFamilyConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

export function resolveUndiciAutoSelectFamilyConnectOptions():
  | { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number }
  | undefined {
  return createUndiciAutoSelectFamilyConnectOptions(resolveUndiciAutoSelectFamily());
}
