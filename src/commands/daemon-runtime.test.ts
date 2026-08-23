import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  isGatewayDaemonRuntime,
} from "./daemon-runtime.js";

describe("gateway daemon runtime", () => {
  it("accepts only the Node runtime", () => {
    expect(DEFAULT_GATEWAY_DAEMON_RUNTIME).toBe("node");
    expect(GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => option.value)).toEqual(["node"]);
    expect(isGatewayDaemonRuntime("node")).toBe(true);
    expect(isGatewayDaemonRuntime("bun")).toBe(false);
    expect(isGatewayDaemonRuntime(undefined)).toBe(false);
  });
});
