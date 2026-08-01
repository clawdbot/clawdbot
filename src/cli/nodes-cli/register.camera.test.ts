// Node camera command tests cover help text and RPC handling for optional values.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCameraCommands } from "./register.camera.js";
import * as rpc from "./rpc.js";

const capturedInvokeParams: Record<string, unknown>[] = [];

vi.mock("./cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");
  return {
    ...actual,
    runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
  };
});

vi.mock("../nodes-camera.js", async () => {
  const actual = await vi.importActual<typeof import("../nodes-camera.js")>("../nodes-camera.js");
  return {
    ...actual,
    writeCameraPayloadToFile: vi.fn(async () => {}),
    writeCameraClipPayloadToFile: vi.fn(async () => {}),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./rpc.js")>("./rpc.js");
  return {
    ...actual,
    resolveNode: vi.fn(async () => ({
      nodeId: "node-abc123",
      platform: "ios",
      remoteIp: "198.51.100.42",
    })),
    callGatewayCli: vi.fn(async (_method, _opts, invokeParams) => {
      capturedInvokeParams.push(invokeParams as Record<string, unknown>);
      return {
        payload: {
          format: "jpg",
          base64: "redacted-base64",
          width: 1600,
          height: 1200,
        },
      };
    }),
  };
});

function buildRootCommand(): Command {
  const nodes = new Command("nodes");
  registerNodesCameraCommands(nodes);
  return nodes.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

function cameraSnapArgs(extra: string[]): string[] {
  // Commander.parseAsync expects argv[0]/argv[1] to be the node/script names.
  return ["node", "nodes", "camera", "snap", ...extra];
}

describe("nodes camera snap CLI option forwarding", () => {
  beforeEach(() => {
    capturedInvokeParams.length = 0;
    vi.clearAllMocks();
  });

  it("describes node-owned camera defaults in help", () => {
    const nodes = buildRootCommand();
    const camera = nodes.commands.find((command) => command.name() === "camera");
    const snap = camera?.commands.find((command) => command.name() === "snap");
    if (!snap) {
      throw new Error("expected camera snap command");
    }

    expect(snap.options.find((option) => option.long === "--quality")?.description).toBe(
      "JPEG quality (optional; platform-specific default)",
    );
    expect(snap.options.find((option) => option.long === "--delay-ms")?.description).toBe(
      "Delay before capture in ms (optional; platform-specific default)",
    );
  });

  it("omits quality and delayMs from RPC params when flags are not provided", async () => {
    const nodes = buildRootCommand();
    await nodes.parseAsync(cameraSnapArgs(["--node", "test-node"]));

    // Default facing="both" may invoke camera.snap for more than one target.
    expect(rpc.callGatewayCli).toHaveBeenCalled();
    for (const invokeParams of capturedInvokeParams) {
      expect(invokeParams).toMatchObject({
        command: "camera.snap",
        nodeId: "node-abc123",
      });
      expect((invokeParams.params as Record<string, unknown>).quality).toBeUndefined();
      expect((invokeParams.params as Record<string, unknown>).delayMs).toBeUndefined();
    }
  });

  it("forwards explicit --quality and --delay-ms values in RPC params", async () => {
    const nodes = buildRootCommand();
    await nodes.parseAsync(
      cameraSnapArgs(["--node", "test-node", "--quality", "0.7", "--delay-ms", "500"]),
    );

    const firstInvokeParams = capturedInvokeParams[0];
    if (!firstInvokeParams) {
      throw new Error("expected at least one camera.snap node.invoke call");
    }
    const forwardedParams = firstInvokeParams.params as Record<string, unknown>;
    expect(forwardedParams.quality).toBe(0.7);
    expect(forwardedParams.delayMs).toBe(500);
  });

  it("rejects out-of-range --quality", async () => {
    const nodes = buildRootCommand();
    await expect(
      nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--quality", "1.5"])),
    ).rejects.toThrow("--quality must be at most 1");
  });

  it("rejects negative --delay-ms", async () => {
    const nodes = buildRootCommand();
    await expect(
      nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--delay-ms", "-1"])),
    ).rejects.toThrow("--delay-ms must be a non-negative integer");
  });
});
