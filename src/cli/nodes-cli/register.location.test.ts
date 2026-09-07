import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesLocationCommands } from "./register.location.js";

const mocks = vi.hoisted(() => ({
  resolveCliNodeId: vi.fn(async () => "node-1"),
  callNodesGatewayCli: vi.fn(async () => ({ payload: { lat: 48.2, lon: 16.3 } })),
}));

vi.mock("./cli-utils.js", () => ({
  runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
}));

vi.mock("./rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./rpc.js")>("./rpc.js");
  return {
    ...actual,
    resolveCliNodeId: mocks.resolveCliNodeId,
    callNodesGatewayCli: mocks.callNodesGatewayCli,
  };
});

vi.mock("../../gateway/call.js", () => ({
  randomIdempotencyKey: () => "location-test-key",
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    writeJson: vi.fn(),
    log: vi.fn(),
  },
}));

function createNodesCommand(): Command {
  const nodes = new Command("nodes");
  registerNodesLocationCommands(nodes);
  return nodes.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

describe("nodes location get validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unsupported accuracy values before resolving or invoking a node", async () => {
    const nodes = createNodesCommand();

    await expect(
      nodes.parseAsync([
        "node",
        "nodes",
        "location",
        "get",
        "--node",
        "node-1",
        "--accuracy",
        "approximate",
      ]),
    ).rejects.toThrow("invalid --accuracy (use coarse|balanced|precise)");

    expect(mocks.resolveCliNodeId).not.toHaveBeenCalled();
    expect(mocks.callNodesGatewayCli).not.toHaveBeenCalled();
  });

  it("normalizes and forwards supported accuracy values", async () => {
    const nodes = createNodesCommand();

    await nodes.parseAsync([
      "node",
      "nodes",
      "location",
      "get",
      "--node",
      "node-1",
      "--accuracy",
      "PRECISE",
    ]);

    expect(mocks.callNodesGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({ desiredAccuracy: "precise" }),
      }),
    );
  });

  it.each(["", " \t "])(
    "rejects explicit blank --location-timeout %j before resolving or invoking a node",
    async (locationTimeout) => {
      const nodes = createNodesCommand();

      await expect(
        nodes.parseAsync([
          "node",
          "nodes",
          "location",
          "get",
          "--node",
          "node-1",
          "--location-timeout",
          locationTimeout,
        ]),
      ).rejects.toThrow("--location-timeout must be a positive integer");

      expect(mocks.resolveCliNodeId).not.toHaveBeenCalled();
      expect(mocks.callNodesGatewayCli).not.toHaveBeenCalled();
    },
  );
});
