// Node daemon install helper tests cover node daemon install plans and runtime warnings.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredNodePath: vi.fn(),
  resolveNodeProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildNodeServiceEnvironment: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
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
      version: "22.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      nodePath: "/custom/node/bin/node",
    });

    expect(plan.environment).toEqual({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
    });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: ["/custom/node/bin"],
    });
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "22.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      nodePath: "node",
    });

    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: undefined,
    });
  });

  it("marks node gateway tokens as file-backed service env", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "22.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_GATEWAY_TOKEN: "node-token",
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    const plan = await buildNodeInstallPlan({
      env: { OPENCLAW_GATEWAY_TOKEN: "node-token" },
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
    });
  });
});
