import { resolve } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export type FaceTimeDriverStatus = "current" | "invalid" | "missing" | "outdated";

type DriverSetupParams = {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  signal?: AbortSignal;
};

function readDriverStatus(output: string): FaceTimeDriverStatus {
  const status = output.trim();
  if (
    status === "current" ||
    status === "invalid" ||
    status === "missing" ||
    status === "outdated"
  ) {
    return status;
  }
  throw new Error(`Unexpected FaceTime driver status: ${status || "(empty)"}`);
}

export async function inspectFaceTimeDriver(
  params: DriverSetupParams,
): Promise<FaceTimeDriverStatus> {
  const script = resolve(params.pluginRoot, "scripts", "install-driver.sh");
  const result = await params.runCommandWithTimeout(["/bin/sh", script, "--status"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `driver status exited ${result.code}`);
  }
  return readDriverStatus(result.stdout);
}

export async function installFaceTimeDriver(
  params: DriverSetupParams & { callActive: boolean },
): Promise<{ changed: boolean; status: "current" }> {
  if (params.callActive) {
    throw new Error("Cannot install the FaceTime audio driver during an active or pending call");
  }
  const before = await inspectFaceTimeDriver(params);
  if (before === "current") {
    return { changed: false, status: "current" };
  }
  const script = resolve(params.pluginRoot, "scripts", "install-driver.sh");
  const result = await params.runCommandWithTimeout(["/bin/sh", script, "--ensure"], {
    // The macOS administrator sheet can legitimately remain open while the
    // operator is away. Runtime shutdown aborts the whole process tree instead.
    killProcessTree: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime audio driver installation failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const after = await inspectFaceTimeDriver(params);
  if (after !== "current") {
    throw new Error(`FaceTime audio driver did not become current (status: ${after})`);
  }
  return { changed: true, status: after };
}

export async function uninstallFaceTimeDriver(params: DriverSetupParams): Promise<void> {
  const script = resolve(params.pluginRoot, "scripts", "install-driver.sh");
  const result = await params.runCommandWithTimeout(["/bin/sh", script, "--uninstall"], {
    killProcessTree: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime uninstall failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
}
