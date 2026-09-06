import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeHelperPeer } from "./helper-rpc.js";

export async function terminateExactCarrierProcesses(params: {
  runtime: PluginRuntime;
  peers: ReadonlyMap<number, FaceTimeHelperPeer>;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  if (params.peers.size === 0) {
    throw new Error(
      "no authenticated carrier process identity is available for fail-closed shutdown",
    );
  }
  for (const peer of params.peers.values()) {
    const inspected = await params.runtime.system.runCommandWithTimeout(
      ["/bin/ps", "-p", String(peer.processId), "-o", "comm="],
      { timeoutMs: 500 },
    );
    params.assertCurrent();
    const executable = inspected.stdout.trim();
    const started = await params.runtime.system.runCommandWithTimeout(
      ["/bin/ps", "-p", String(peer.processId), "-o", "lstart="],
      { timeoutMs: 500 },
    );
    params.assertCurrent();
    const observedStartedAt = Date.parse(started.stdout.trim());
    const expected =
      peer.bundleIdentifier === "com.apple.FaceTime"
        ? "FaceTime"
        : peer.bundleIdentifier === "com.apple.FaceTime.FTConversationService"
          ? "FTConversationService"
          : peer.bundleIdentifier === "com.apple.mobilephone"
            ? "Phone"
            : peer.bundleIdentifier === "com.apple.TelephonyUtilities"
              ? "TelephonyUtilities"
              : "";
    if (
      inspected.code !== 0 ||
      !expected ||
      (executable !== expected && !executable.endsWith(`/${expected}`)) ||
      started.code !== 0 ||
      !Number.isFinite(observedStartedAt) ||
      Math.abs(observedStartedAt - peer.processStartedAtMs) >= 1_000
    ) {
      throw new Error("authenticated carrier process identity no longer matches its executable");
    }
    await params.runtime.system.runCommandWithTimeout(
      ["/bin/kill", "-TERM", String(peer.processId)],
      { timeoutMs: 500 },
    );
    params.assertCurrent();
    const alive = await params.runtime.system.runCommandWithTimeout(
      ["/bin/kill", "-0", String(peer.processId)],
      { timeoutMs: 500 },
    );
    params.assertCurrent();
    if (alive.code === 0) {
      await params.runtime.system.runCommandWithTimeout(
        ["/bin/kill", "-KILL", String(peer.processId)],
        { timeoutMs: 500 },
      );
      params.assertCurrent();
    }
  }
}
