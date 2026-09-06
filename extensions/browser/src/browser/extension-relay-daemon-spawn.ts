import { spawn } from "node:child_process";
import net from "node:net";
import type { OpenClawConfig } from "../sdk-config.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import type { BrowserNativeRelayEnsureStatus } from "./extension-native-protocol.js";
import { readExtensionRelayToken } from "./extension-relay/relay-auth.js";

const PORT_PROBE_TIMEOUT_MS = 750;

/** True when something already accepts connections on the loopback port. */
async function isRelayPortServed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (served: boolean): void => {
      socket.destroy();
      resolve(served);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Ensure the standalone relay daemon serves the extension relay port. The
 * daemon is spawned detached so it outlives this one-shot native host; binding
 * the port is the single-instance lock, so concurrent spawns are harmless.
 */
export async function ensureExtensionRelayDaemonProcess(params: {
  port: number;
  cfg: OpenClawConfig;
  entryPath: string;
  execPath?: string;
  readToken?: () => string | null;
  probe?: (port: number) => Promise<boolean>;
  spawnProcess?: (command: string, args: string[]) => void;
}): Promise<BrowserNativeRelayEnsureStatus> {
  // Resolve current config only after native caller validation. A pairing may
  // outlive its profile; never wake a removed target or substitute another port.
  const resolved = resolveBrowserConfig(params.cfg.browser, params.cfg);
  const configured = Object.keys(resolved.profiles).some((name) => {
    const profile = resolved.profiles[name];
    return (
      profile?.driver === "extension" && resolveProfile(resolved, name)?.cdpPort === params.port
    );
  });
  if (!resolved.enabled || !configured) {
    throw new Error("Relay port is not configured for an extension profile");
  }
  const readToken = params.readToken ?? readExtensionRelayToken;
  if (!readToken()) {
    return "skipped";
  }
  const probe = params.probe ?? isRelayPortServed;
  if (await probe(params.port)) {
    return "running";
  }
  const spawnProcess =
    params.spawnProcess ??
    ((command: string, args: string[]): void => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref();
    });
  spawnProcess(params.execPath ?? process.execPath, [
    params.entryPath,
    "--port",
    String(params.port),
  ]);
  return "spawned";
}
