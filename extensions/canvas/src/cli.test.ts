// Canvas tests cover cli plugin behavior.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultCanvasCliDependencies,
  registerNodesCanvasCommands,
  type CanvasCliDependencies,
} from "./cli.js";

function createCanvasCliDeps() {
  const writtenFiles: Array<{ filePath: string; base64: string }> = [];
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
  };
  const deps: CanvasCliDependencies = {
    defaultRuntime: runtime,
    nodesCallOpts: (cmd, defaults) =>
      cmd
        .option("--url <url>", "Gateway WebSocket URL")
        .option("--token <token>", "Gateway token")
        .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
        .option("--json", "Output JSON", false),
    runNodesCommand: async (_label, action) => {
      await action();
    },
    getNodesTheme: () => ({ ok: (value) => value }),
    parseTimeoutMs: (raw) => (typeof raw === "string" ? Number.parseInt(raw, 10) : undefined),
    resolveNodeId: async (opts) => opts.node ?? "ios-node",
    buildNodeInvokeParams: ({ nodeId, command, params, timeoutMs }) => ({
      nodeId,
      command,
      params,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    }),
    callGatewayCli: vi.fn(async () => ({
      payload: {
        format: "png",
        base64: "aGk=",
      },
    })),
    writeBase64ToFile: async (filePath, base64) => {
      writtenFiles.push({ filePath, base64 });
    },
    shortenHomePath: (filePath) => filePath,
  };
  return { deps, runtime, writtenFiles };
}

function createCanvasCliDepsWithDefaultParsers() {
  const baseDeps = createDefaultCanvasCliDependencies();
  const harness = createCanvasCliDeps();
  return {
    ...harness,
    deps: {
      ...baseDeps,
      defaultRuntime: harness.runtime,
      nodesCallOpts: harness.deps.nodesCallOpts,
      runNodesCommand: harness.deps.runNodesCommand,
      getNodesTheme: harness.deps.getNodesTheme,
      resolveNodeId: harness.deps.resolveNodeId,
      buildNodeInvokeParams: harness.deps.buildNodeInvokeParams,
      callGatewayCli: harness.deps.callGatewayCli,
      writeBase64ToFile: harness.deps.writeBase64ToFile,
      shortenHomePath: harness.deps.shortenHomePath,
    },
  };
}

const canvasAcknowledgementCommands = [
  {
    args: ["present"],
    command: "canvas.present",
    message: "canvas present ok",
  },
  {
    args: ["hide"],
    command: "canvas.hide",
    message: "canvas hide ok",
  },
  {
    args: ["navigate", "https://example.com"],
    command: "canvas.navigate",
    message: "canvas navigate ok",
  },
  {
    args: ["a2ui", "push", "--text", "hello"],
    command: "canvas.a2ui.pushJSONL",
    message: "canvas a2ui push ok (v0.8, 2 messages)",
  },
  {
    args: ["a2ui", "reset"],
    command: "canvas.a2ui.reset",
    message: "canvas a2ui reset ok",
  },
] as const;

const canvasInvocationCommands = [
  ...canvasAcknowledgementCommands,
  { args: ["snapshot"], command: "canvas.snapshot" },
  { args: ["eval", "1 + 1"], command: "canvas.eval" },
] as const;

describe("canvas CLI", () => {
  it("registers under nodes and captures a snapshot media path", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, runtime, writtenFiles } = createCanvasCliDeps();

    registerNodesCanvasCommands(nodes, deps);
    await program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node"], {
      from: "user",
    });

    expect(deps.callGatewayCli).toHaveBeenCalledTimes(1);
    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      {
        node: "ios-node",
        format: "jpg",
        timeout: "60000",
        json: false,
        invokeTimeout: "20000",
      },
      {
        nodeId: "ios-node",
        command: "canvas.snapshot",
        params: {
          format: "jpeg",
          maxWidth: undefined,
          quality: undefined,
        },
        timeoutMs: 20000,
      },
      { transportTimeoutMs: 60_000 },
    );
    expect(writtenFiles).toHaveLength(1);
    const [writtenFile] = writtenFiles;
    if (!writtenFile) {
      throw new Error("Expected canvas snapshot file");
    }
    expect(writtenFile.filePath).toMatch(/openclaw-canvas-snapshot-.*\.png$/);
    expect(writtenFile.base64).toBe("aGk=");
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const savedPath = runtime.log.mock.calls[0]?.[0];
    expect(savedPath?.startsWith("MEDIA:")).toBe(false);
    expect(savedPath?.endsWith(".png")).toBe(true);
  });

  it("rejects node-controlled snapshot formats before writing", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, writtenFiles } = createCanvasCliDeps();
    vi.mocked(deps.callGatewayCli).mockResolvedValueOnce({
      payload: {
        format: "/../../target.sh",
        base64: "aGk=",
      },
    });

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node"], {
        from: "user",
      }),
    ).rejects.toThrow(/invalid canvas\.snapshot payload/i);
    expect(writtenFiles).toHaveLength(0);
  });

  it("rejects malformed node-controlled snapshot base64 before writing", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, writtenFiles } = createCanvasCliDeps();
    vi.mocked(deps.callGatewayCli).mockResolvedValueOnce({
      payload: {
        format: "png",
        base64: "Zh==",
      },
    });

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node"], {
        from: "user",
      }),
    ).rejects.toThrow(/invalid canvas\.snapshot payload/i);
    expect(writtenFiles).toHaveLength(0);
  });

  it("rejects unsupported snapshot formats before invoking the node", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, writtenFiles } = createCanvasCliDeps();

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "gif"], {
        from: "user",
      }),
    ).rejects.toThrow(/invalid format: gif/i);
    expect(deps.callGatewayCli).not.toHaveBeenCalled();
    expect(writtenFiles).toHaveLength(0);
  });

  it("prints an empty canvas eval result instead of a success placeholder", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, runtime } = createCanvasCliDeps();
    vi.mocked(deps.callGatewayCli).mockResolvedValueOnce({ payload: { result: "" } });

    registerNodesCanvasCommands(nodes, deps);
    await program.parseAsync(["nodes", "canvas", "eval", `""`, "--node", "ios-node"], {
      from: "user",
    });

    expect(runtime.log).toHaveBeenCalledWith("");
    expect(runtime.log).not.toHaveBeenCalledWith("canvas eval ok");
  });

  it.each(canvasInvocationCommands)(
    "keeps the default $command Gateway deadline longer than the node deadline",
    async ({ args, command }) => {
      const program = new Command();
      program.exitOverride();
      const { deps } = createCanvasCliDeps();

      registerNodesCanvasCommands(program.command("nodes"), deps);
      await program.parseAsync(["nodes", "canvas", ...args, "--node", "ios-node"], {
        from: "user",
      });

      const invokeTimeoutMs = command === "canvas.snapshot" ? 20_000 : 30_000;
      const transportTimeoutMs = command === "canvas.snapshot" ? 60_000 : 40_000;
      expect(deps.callGatewayCli).toHaveBeenCalledWith(
        "node.invoke",
        expect.any(Object),
        expect.objectContaining({ command, timeoutMs: invokeTimeoutMs }),
        { transportTimeoutMs },
      );
    },
  );

  it.each(canvasInvocationCommands)(
    "keeps an explicit $command Gateway deadline longer than the node deadline",
    async ({ args, command }) => {
      const program = new Command();
      program.exitOverride();
      const { deps } = createCanvasCliDeps();

      registerNodesCanvasCommands(program.command("nodes"), deps);
      await program.parseAsync(
        ["nodes", "canvas", ...args, "--node", "ios-node", "--invoke-timeout", "35000"],
        { from: "user" },
      );

      expect(deps.callGatewayCli).toHaveBeenCalledWith(
        "node.invoke",
        expect.any(Object),
        expect.objectContaining({ command, timeoutMs: 35_000 }),
        { transportTimeoutMs: command === "canvas.snapshot" ? 60_000 : 45_000 },
      );
    },
  );

  it("preserves an explicit Gateway timeout longer than the node deadline and grace", async () => {
    const program = new Command();
    program.exitOverride();
    const { deps } = createCanvasCliDeps();

    registerNodesCanvasCommands(program.command("nodes"), deps);
    await program.parseAsync(
      [
        "nodes",
        "canvas",
        "present",
        "--node",
        "ios-node",
        "--invoke-timeout",
        "35000",
        "--timeout",
        "120000",
      ],
      { from: "user" },
    );

    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeout: "120000" }),
      expect.objectContaining({ timeoutMs: 35_000 }),
      { transportTimeoutMs: 120_000 },
    );
  });

  it("preserves the snapshot command's existing longer Gateway timeout", async () => {
    const program = new Command();
    program.exitOverride();
    const { deps } = createCanvasCliDeps();
    deps.nodesCallOpts = createDefaultCanvasCliDependencies().nodesCallOpts;

    registerNodesCanvasCommands(program.command("nodes"), deps);
    await program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node"], {
      from: "user",
    });

    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeout: "60000" }),
      expect.objectContaining({ timeoutMs: 20_000 }),
      { transportTimeoutMs: 60_000 },
    );
  });

  it("preserves an invalid explicit Gateway timeout for its existing validation", async () => {
    const program = new Command();
    program.exitOverride();
    const { deps } = createCanvasCliDepsWithDefaultParsers();
    deps.callGatewayCli = vi.fn(async (_method, _opts, _params, callOpts) => {
      if (callOpts?.transportTimeoutMs !== undefined) {
        throw new Error("invalid Gateway timeout was replaced");
      }
      throw new Error('Invalid --timeout. Received: "20ms".');
    });

    registerNodesCanvasCommands(program.command("nodes"), deps);

    await expect(
      program.parseAsync(
        ["nodes", "canvas", "present", "--node", "ios-node", "--timeout", "20ms"],
        {
          from: "user",
        },
      ),
    ).rejects.toThrow('Invalid --timeout. Received: "20ms".');
  });

  it("caps oversized node and Gateway deadlines to the timer-safe maximum", async () => {
    const program = new Command();
    program.exitOverride();
    const { deps } = createCanvasCliDepsWithDefaultParsers();

    registerNodesCanvasCommands(program.command("nodes"), deps);
    await program.parseAsync(
      [
        "nodes",
        "canvas",
        "present",
        "--node",
        "ios-node",
        "--invoke-timeout",
        String(Number.MAX_SAFE_INTEGER),
      ],
      { from: "user" },
    );

    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 2_147_000_000 }),
      { transportTimeoutMs: 2_147_000_000 },
    );
  });

  it.each(canvasAcknowledgementCommands)(
    "prints the full successful $command Gateway response with --json",
    async ({ args, command }) => {
      const program = new Command();
      program.exitOverride();
      const nodes = program.command("nodes");
      const { deps, runtime } = createCanvasCliDeps();
      const response = {
        ok: true,
        nodeId: "ios-node",
        command,
        payload: { acknowledged: true },
        payloadJSON: '{"acknowledged":true}',
      };
      vi.mocked(deps.callGatewayCli).mockResolvedValueOnce(response);

      registerNodesCanvasCommands(nodes, deps);
      await program.parseAsync(["nodes", "canvas", ...args, "--node", "ios-node", "--json"], {
        from: "user",
      });

      expect(deps.callGatewayCli).toHaveBeenCalledTimes(1);
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(response);
      expect(runtime.log).not.toHaveBeenCalled();
    },
  );

  it.each(canvasAcknowledgementCommands)(
    "preserves the human-readable $command acknowledgement",
    async ({ args, message }) => {
      const program = new Command();
      program.exitOverride();
      const nodes = program.command("nodes");
      const { deps, runtime } = createCanvasCliDeps();

      registerNodesCanvasCommands(nodes, deps);
      await program.parseAsync(["nodes", "canvas", ...args, "--node", "ios-node"], {
        from: "user",
      });

      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(message);
      expect(runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("does not print a machine-readable success response when a Canvas invocation fails", async () => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps, runtime } = createCanvasCliDeps();
    vi.mocked(deps.callGatewayCli).mockRejectedValueOnce(new Error("node disconnected"));

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "present", "--node", "ios-node", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow("node disconnected");
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each([
    ["--max-width", "640px", "--max-width must be a positive integer."],
    ["--quality", "0.8x", "--quality must be a number."],
    ["--quality", "-0.1", "--quality must be between 0 and 1."],
    ["--quality", "5", "--quality must be between 0 and 1."],
  ])("rejects partial numeric snapshot %s values", async (flag, value, message) => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps } = createCanvasCliDeps();

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "snapshot", "--node", "ios-node", flag, value], {
        from: "user",
      }),
    ).rejects.toThrow(message);
    expect(deps.callGatewayCli).not.toHaveBeenCalled();
  });

  it.each(["0", "1"])("accepts snapshot --quality boundary value %s", async (quality) => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps } = createCanvasCliDeps();

    registerNodesCanvasCommands(nodes, deps);

    await program.parseAsync(
      ["nodes", "canvas", "snapshot", "--node", "ios-node", "--quality", quality],
      {
        from: "user",
      },
    );
    expect(deps.callGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({
        params: expect.objectContaining({
          quality: Number(quality),
        }),
      }),
      { transportTimeoutMs: 60_000 },
    );
  });

  it.each([
    ["snapshot"],
    ["present"],
    ["hide"],
    ["navigate", "https://example.com"],
    ["eval", "1 + 1"],
    ["a2ui", "push", "--text", "hello"],
    ["a2ui", "reset"],
  ])("rejects invalid %s invoke timeouts before invoking the node", async (...args) => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps } = createCanvasCliDepsWithDefaultParsers();
    deps.resolveNodeId = vi.fn(async () => {
      throw new Error("resolveNodeId should not be called");
    });

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(
        ["nodes", "canvas", ...args, "--node", "ios-node", "--invoke-timeout", "20ms"],
        {
          from: "user",
        },
      ),
    ).rejects.toThrow("--invoke-timeout must be a positive integer.");
    expect(deps.resolveNodeId).not.toHaveBeenCalled();
    expect(deps.callGatewayCli).not.toHaveBeenCalled();
  });

  it.each([
    ["--x", "1x"],
    ["--y", "2px"],
    ["--width", "800wide"],
    ["--height", "600tall"],
  ])("rejects partial numeric present %s values", async (flag, value) => {
    const program = new Command();
    program.exitOverride();
    const nodes = program.command("nodes");
    const { deps } = createCanvasCliDeps();

    registerNodesCanvasCommands(nodes, deps);

    await expect(
      program.parseAsync(["nodes", "canvas", "present", "--node", "ios-node", flag, value], {
        from: "user",
      }),
    ).rejects.toThrow(`${flag} must be a number.`);
    expect(deps.callGatewayCli).not.toHaveBeenCalled();
  });
});
