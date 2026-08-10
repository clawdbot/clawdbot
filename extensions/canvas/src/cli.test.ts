import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultCanvasCliDependencies,
  registerNodesCanvasCommands,
  type CanvasCliDependencies,
} from "./cli.js";

function createDeps() {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  };
  const defaults = createDefaultCanvasCliDependencies();
  const deps: CanvasCliDependencies = {
    ...defaults,
    defaultRuntime: runtime,
    runNodesCommand: (_label, action) => action(),
    getNodesTheme: () => ({ ok: (value) => value }),
    resolveNodeId: vi.fn(async () => "mac-1"),
    callGatewayCli: vi.fn(async () => ({ ok: true })),
  };
  return { deps, runtime };
}

function createProgram(deps: CanvasCliDependencies) {
  const program = new Command();
  program.exitOverride();
  registerNodesCanvasCommands(program.command("nodes"), deps);
  return program;
}

describe("nodes canvas CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers only presenter commands", () => {
    const { deps } = createDeps();
    const program = createProgram(deps);
    const canvas = program.commands[0]?.commands.find((command) => command.name() === "canvas");

    expect(canvas?.commands.map((command) => command.name())).toEqual([
      "present",
      "hide",
      "navigate",
    ]);
  });

  it.each([
    {
      args: ["present"],
      command: "canvas.present",
      params: {},
      message: "canvas present ok",
    },
    {
      args: ["hide"],
      command: "canvas.hide",
      params: undefined,
      message: "canvas hide ok",
    },
    {
      args: ["navigate", "/__openclaw__/canvas/documents/cv_1/index.html"],
      command: "canvas.navigate",
      params: { url: "/__openclaw__/canvas/documents/cv_1/index.html" },
      message: "canvas navigate ok",
    },
  ])(
    "invokes $command and prints its acknowledgement",
    async ({ args, command, params, message }) => {
      const { deps, runtime } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync(["nodes", "canvas", ...args, "--node", "Studio"], {
        from: "user",
      });

      expect(deps.resolveNodeId).toHaveBeenCalledWith(expect.any(Object), "Studio");
      expect(deps.callGatewayCli).toHaveBeenCalledWith(
        "node.invoke",
        expect.any(Object),
        {
          nodeId: "mac-1",
          command,
          params,
          timeoutMs: 30_000,
          idempotencyKey: expect.any(String),
        },
        { transportTimeoutMs: 40_000 },
      );
      expect(runtime.log).toHaveBeenCalledWith(message);
    },
  );

  it("preserves present target and placement fields", async () => {
    const { deps } = createDeps();
    const program = createProgram(deps);

    await program.parseAsync(
      [
        "nodes",
        "canvas",
        "present",
        "--node",
        "mac-1",
        "--target",
        "openclaw://widget/local",
        "--x",
        "10.5",
        "--y",
        "-2",
        "--width",
        "640",
        "--height",
        "480",
      ],
      { from: "user" },
    );

    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({
        command: "canvas.present",
        params: {
          url: "openclaw://widget/local",
          placement: { x: 10.5, y: -2, width: 640, height: 480 },
        },
      }),
      expect.any(Object),
    );
  });

  it("prints the full Gateway response in JSON mode", async () => {
    const { deps, runtime } = createDeps();
    const response = { ok: true, command: "canvas.hide", payload: { acknowledged: true } };
    vi.mocked(deps.callGatewayCli).mockResolvedValue(response);
    const program = createProgram(deps);

    await program.parseAsync(["nodes", "canvas", "hide", "--node", "mac-1", "--json"], {
      from: "user",
    });

    expect(runtime.writeJson).toHaveBeenCalledWith(response);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps the Gateway deadline longer than an explicit node deadline", async () => {
    const { deps } = createDeps();
    const program = createProgram(deps);

    await program.parseAsync(
      ["nodes", "canvas", "hide", "--node", "mac-1", "--invoke-timeout", "35000"],
      { from: "user" },
    );

    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 35_000 }),
      { transportTimeoutMs: 45_000 },
    );
  });

  it.each([
    ["--x", "1x", "--x must be a number."],
    ["--width", "640px", "--width must be a number."],
    ["--invoke-timeout", "20ms", "--invoke-timeout must be a positive integer."],
  ])("rejects invalid present %s values", async (flag, value, message) => {
    const { deps } = createDeps();
    const program = createProgram(deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "present", "--node", "mac-1", flag, value], {
        from: "user",
      }),
    ).rejects.toThrow(message);
    expect(deps.callGatewayCli).not.toHaveBeenCalled();
  });
});
