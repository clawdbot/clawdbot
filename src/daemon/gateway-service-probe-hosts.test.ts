import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfg: {} as {
    gateway?: {
      bind?: "auto" | "custom" | "lan" | "loopback" | "tailnet";
      customBindHost?: string;
      tailscale?: { mode?: "off" | "serve" | "funnel" };
    };
  },
  createConfigIO: vi.fn(),
  defaultGatewayBindMode: vi.fn<(_tailscaleMode?: string) => "loopback" | "auto">(() => "loopback"),
  isContainerEnvironment: vi.fn(() => false),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
}));

vi.mock("../config/io.runtime.js", () => ({
  createConfigIO: (options: unknown) => mocks.createConfigIO(options),
}));

vi.mock("../gateway/net.js", () => ({
  defaultGatewayBindMode: (tailscaleMode?: string) => mocks.defaultGatewayBindMode(tailscaleMode),
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "192.0.2.40" || bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: () => mocks.isContainerEnvironment(),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => mocks.pickPrimaryTailnetIPv4(),
}));

import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";

describe("resolveGatewayServiceProbeHosts", () => {
  beforeEach(() => {
    mocks.cfg = {};
    mocks.createConfigIO.mockReset();
    mocks.createConfigIO.mockImplementation(() => ({
      readBestEffortConfig: async () => mocks.cfg,
    }));
    mocks.defaultGatewayBindMode.mockReset();
    mocks.defaultGatewayBindMode.mockReturnValue("loopback");
    mocks.isContainerEnvironment.mockReset();
    mocks.isContainerEnvironment.mockReturnValue(false);
    mocks.pickPrimaryTailnetIPv4.mockReset();
    mocks.pickPrimaryTailnetIPv4.mockReturnValue(undefined);
  });

  it.each([
    {
      name: "custom",
      gateway: { bind: "custom" as const, customBindHost: "192.0.2.40" },
      tailnetIPv4: undefined,
      expected: ["192.0.2.40", "127.0.0.1"],
    },
    {
      name: "LAN wildcard",
      gateway: { bind: "lan" as const },
      tailnetIPv4: undefined,
      expected: ["0.0.0.0"],
    },
    {
      name: "tailnet",
      gateway: { bind: "tailnet" as const },
      tailnetIPv4: "100.64.0.40",
      expected: ["100.64.0.40", "127.0.0.1"],
    },
  ])(
    "returns the configured $name endpoint without a bind-availability probe",
    async (testCase) => {
      mocks.cfg = { gateway: testCase.gateway };
      mocks.pickPrimaryTailnetIPv4.mockReturnValue(testCase.tailnetIPv4);

      await expect(
        resolveGatewayServiceProbeHosts({
          env: { OPENCLAW_STATE_DIR: "/tmp/cli-state" },
          command: {
            programArguments: ["node", "gateway.js"],
            environment: { OPENCLAW_STATE_DIR: "/tmp/service-state" },
          },
        }),
      ).resolves.toEqual(testCase.expected);

      expect(mocks.createConfigIO).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/tmp/service-state" }),
          pluginValidation: "skip",
          suppressFutureVersionWarning: true,
        }),
      );
    },
  );
});
