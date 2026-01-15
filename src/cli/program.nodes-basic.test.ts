import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommand = vi.fn();
const statusCommand = vi.fn();
const configureCommand = vi.fn();
const configureCommandWithSections = vi.fn();
const setupCommand = vi.fn();
const onboardCommand = vi.fn();
const callGateway = vi.fn();
const runChannelLogin = vi.fn();
const runChannelLogout = vi.fn();
const runTui = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/message.js", () => ({ messageCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
  ],
  configureCommand,
  configureCommandWithSections,
}));
vi.mock("../commands/setup.js", () => ({ setupCommand }));
vi.mock("../commands/onboard.js", () => ({ onboardCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("./channel-auth.js", () => ({ runChannelLogin, runChannelLogout }));
vi.mock("../tui/tui.js", () => ({ runTui }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));

const { buildProgram } = await import("./program.js");

describe("cli program (nodes basics)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs nodes list and calls node.pair.list", async () => {
    callGateway.mockResolvedValue({ pending: [], paired: [] });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    expect(runtime.log).toHaveBeenCalledWith("Pending: 0 · Paired: 0");
  });

  it("runs nodes status and calls node.list", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "ios-node",
          displayName: "iOS Node",
          remoteIp: "192.168.0.88",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          paired: true,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Known: 1 · Paired: 1 · Connected: 1");
    expect(output).toContain("iOS Node");
    expect(output).toContain("device: iPad");
    expect(output).toContain("hw: iPad16,6");
    expect(output).toContain("paired");
    expect(output).toContain("caps: [camera,canvas]");
  });

  it("runs nodes status and shows unpaired nodes", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "android-node",
          displayName: "Peter's Tab S10 Ultra",
          remoteIp: "192.168.0.99",
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          caps: ["canvas", "camera"],
          paired: false,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Known: 1 · Paired: 0 · Connected: 1");
    expect(output).toContain("Peter's Tab S10 Ultra");
    expect(output).toContain("device: Android");
    expect(output).toContain("hw: samsung SM-X926B");
    expect(output).toContain("unpaired");
    expect(output).toContain("connected");
    expect(output).toContain("caps: [camera,canvas]");
  });

  it("runs nodes describe and calls node.describe", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodeId: "ios-node",
        displayName: "iOS Node",
        caps: ["canvas", "camera"],
        commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
        connected: true,
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "describe", "--node", "ios-node"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(out).toContain("Commands:");
    expect(out).toContain("canvas.eval");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      requestId: "r1",
      node: { nodeId: "n1", token: "t1" },
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "approve", "r1"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });

  it("runs nodes invoke and calls node.invoke", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "canvas.eval",
        payload: { result: "ok" },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "invoke",
        "--node",
        "ios-node",
        "--command",
        "canvas.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "1+1" },
          timeoutMs: 15000,
          idempotencyKey: "idem-test",
        },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });
});
