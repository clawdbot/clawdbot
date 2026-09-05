import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  isGatewayDaemonRuntime,
  resolveGatewayDaemonRuntime,
} from "./daemon-runtime.js";

describe("gateway daemon runtime", () => {
  it("keeps Node as the default while accepting Bun", () => {
    expect(DEFAULT_GATEWAY_DAEMON_RUNTIME).toBe("node");
    expect(GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => option.value)).toEqual(["node", "bun"]);
    expect(isGatewayDaemonRuntime("node")).toBe(true);
    expect(isGatewayDaemonRuntime("bun")).toBe(true);
    expect(isGatewayDaemonRuntime(undefined)).toBe(false);
  });

  it("detects Bun service commands without changing the Node fallback", () => {
    expect(resolveGatewayDaemonRuntime(["/home/test/.bun/bin/bun", "openclaw.mjs"])).toBe("bun");
    expect(resolveGatewayDaemonRuntime(["C:\\Users\\test\\.bun\\bin\\BUN.EXE"])).toBe("bun");
    expect(resolveGatewayDaemonRuntime(["/usr/bin/node", "openclaw.mjs"])).toBe("node");
    expect(resolveGatewayDaemonRuntime(["/usr/local/bin/custom-wrapper"])).toBe("node");
  });
});
