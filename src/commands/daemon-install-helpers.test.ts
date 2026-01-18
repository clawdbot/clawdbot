import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/clawdbot/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\clawdbot\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/clawdbot/dist/cli/index.js"])).toBe(false);
  });
});

describe("buildGatewayInstallPlan", () => {
  it("uses provided nodePath and returns plan", async () => {
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["node", "gateway"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/opt/node",
      version: "22.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildServiceEnvironment.mockReturnValue({ CLAWDBOT_PORT: "3000" });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ CLAWDBOT_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["node", "gateway"],
      workingDirectory: undefined,
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/opt/node",
      version: "18.0.0",
      supported: false,
    });
    mocks.renderSystemNodeWarning.mockReturnValue("Node too old");
    mocks.buildServiceEnvironment.mockReturnValue({});

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Run as administrator");
    expect(gatewayInstallErrorHint("linux")).toContain("clawdbot daemon install");
  });
});
