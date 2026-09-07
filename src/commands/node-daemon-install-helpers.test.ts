// Node daemon install helper tests cover node daemon install plans and runtime warnings.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredBunPath: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveNodeProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildNodeServiceEnvironment: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredBunPath: mocks.resolvePreferredBunPath,
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveNodeProgramArguments: mocks.resolveNodeProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildNodeServiceEnvironment: mocks.buildNodeServiceEnvironment,
}));

import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildNodeInstallPlan", () => {
  it("passes the selected node bin directory into the node service environment", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/opt/node/bin/node",
      version: "26.8.1",
      status: "supported",
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_MARKER: "openclaw",
    });

    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      runtimePath: "/custom/node/bin/node",
    });

    expect(plan.environment).toEqual({
      OPENCLAW_SERVICE_MARKER: "openclaw",
    });
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      CF_ACCESS_CLIENT_ID: "file",
      CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
    });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: ["/custom/node/bin"],
    });
  });

  it("resolves and forwards Bun for a managed node-host install plan", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    mocks.resolvePreferredBunPath.mockResolvedValue(bunPath);
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: [bunPath, "node-host"],
    });
    mocks.buildNodeServiceEnvironment.mockReturnValue({});

    await buildNodeInstallPlan({
      env: { HOME: "/home/test" },
      host: "127.0.0.1",
      port: 18789,
      runtime: "bun",
    });

    expect(mocks.resolvePreferredBunPath).toHaveBeenCalledWith({
      env: { HOME: "/home/test" },
      runtime: "bun",
    });
    expect(mocks.resolveNodeProgramArguments).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "bun", runtimePath: bunPath }),
    );
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: { HOME: "/home/test" },
      extraPathDirs: ["/home/test/.bun/bin"],
    });
  });

  it("does not prepend '.' when runtimePath is a bare executable name", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "26.8.1",
      status: "supported",
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_MARKER: "openclaw",
    });

    await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      runtimePath: "node",
    });

    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: undefined,
    });
  });

  it("marks node gateway credentials as file-backed service env", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "26.8.1",
      status: "supported",
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_GATEWAY_TOKEN: "node-token",
      OPENCLAW_GATEWAY_PASSWORD: "node-password",
      OPENCLAW_SERVICE_MARKER: "openclaw",
    });

    const plan = await buildNodeInstallPlan({
      env: {
        OPENCLAW_GATEWAY_TOKEN: "node-token",
        OPENCLAW_GATEWAY_PASSWORD: "node-password",
      },
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
    expect(plan.environment.OPENCLAW_GATEWAY_PASSWORD).toBe("node-password");
    expect(plan.description).toBe("OpenClaw Node Host");
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      CF_ACCESS_CLIENT_ID: "file",
      CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
    });
  });
});
