import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { renderGatewayServiceStartHints } from "./shared.js";

export async function runDaemonUninstall() {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon uninstall is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway uninstall failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStart() {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return;
  }
  try {
    await service.restart({ env: process.env, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway start failed: ${String(err)}`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.error(`Start with: ${hint}`);
    }
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStop() {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    return;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway stop failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

/**
 * Restart the gateway daemon service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(): Promise<boolean> {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return false;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return false;
  }
  try {
    await service.restart({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    defaultRuntime.error(`Gateway restart failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return false;
  }
}
