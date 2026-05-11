import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerNodesCanvasCommands, type CanvasCliDependencies } from "./cli.js";

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
    nodesCallOpts: (cmd) =>
      cmd
        .option("--url <url>", "Gateway WebSocket URL")
        .option("--token <token>", "Gateway token")
        .option("--timeout <ms>", "Timeout in ms", "10000")
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
        timeout: "10000",
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
    );
    expect(writtenFiles).toHaveLength(1);
    const [writtenFile] = writtenFiles;
    if (!writtenFile) {
      throw new Error("Expected canvas snapshot file");
    }
    expect(writtenFile.filePath).toMatch(/openclaw-canvas-snapshot-.*\.png$/);
    expect(writtenFile.base64).toBe("aGk=");
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const mediaMessage = runtime.log.mock.calls[0]?.[0];
    expect(mediaMessage?.startsWith("MEDIA:")).toBe(true);
    expect(mediaMessage?.endsWith(".png")).toBe(true);
  });
});
