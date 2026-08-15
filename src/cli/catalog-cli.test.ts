import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { registerCommandsCli } from "./catalog-cli.js";

const loadPluginCliDescriptorEntriesMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/cli-registry-loader.js").loadPluginCliDescriptorEntries>(
    async () => [],
  ),
);

vi.mock("../plugins/cli-registry-loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/cli-registry-loader.js")>();
  return {
    ...original,
    loadPluginCliDescriptorEntries: loadPluginCliDescriptorEntriesMock,
  };
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  registerCommandsCli(program.command("tools"));
  return program;
}

async function captureStdout(run: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("tools commands cli", () => {
  afterEach(() => {
    loadPluginCliDescriptorEntriesMock.mockReset();
    loadPluginCliDescriptorEntriesMock.mockResolvedValue([]);
    loggingState.forceConsoleToStderr = false;
    loggingState.earlyConsoleRoutingRestore = null;
  });

  it("prints parent help for a bare tools commands invocation", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "tools", "commands"]);
    });

    expect(output).toContain("list");
    expect(output).toContain("inspect");
    expect(output).not.toContain("audit");
  });

  it("prints command inventory JSON", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "tools", "commands", "list", "--json"]);
    });
    const parsed = JSON.parse(output) as {
      counts: { commandDescriptors: number; routedOperations: number; runtimeCommands: number };
    };

    expect(parsed.counts.commandDescriptors).toBeGreaterThan(50);
    expect(parsed.counts.routedOperations).toBeGreaterThan(10);
    expect(parsed.counts.runtimeCommands).toBeGreaterThan(0);
  });

  it("inspects an exact nested command path", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "tools",
        "commands",
        "inspect",
        "gateway",
        "status",
        "--json",
      ]);
    });
    const parsed = JSON.parse(output) as {
      found: boolean;
      commandPath: string[];
      routes: unknown[];
    };

    expect(parsed.found).toBe(true);
    expect(parsed.commandPath).toEqual(["gateway", "status"]);
    expect(parsed.routes).toHaveLength(2);
  });

  it("loads a lazy sub-CLI before inspecting a nested command", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "tools",
        "commands",
        "inspect",
        "models",
        "aliases",
        "list",
        "--json",
      ]);
    });
    const parsed = JSON.parse(output) as { found: boolean; runtimeCommands: unknown[] };

    expect(parsed.found).toBe(true);
    expect(parsed.runtimeCommands).toHaveLength(1);
  });

  it("loads a lazy core command group before inspection", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "tools",
        "commands",
        "inspect",
        "message",
        "send",
        "--json",
      ]);
    });
    const parsed = JSON.parse(output) as { found: boolean; runtimeCommands: unknown[] };

    expect(parsed.found).toBe(true);
    expect(parsed.runtimeCommands).toHaveLength(1);
  });

  it("loads plugin descriptors only when requested and keeps JSON clean", async () => {
    const forceStderrSnapshots: boolean[] = [];
    loadPluginCliDescriptorEntriesMock.mockImplementationOnce(async () => {
      forceStderrSnapshots.push(loggingState.forceConsoleToStderr);
      return [
        {
          pluginId: "example-plugin",
          parentPath: [],
          commands: ["example"],
          descriptors: [
            { name: "example", description: "Example plugin command", hasSubcommands: false },
          ],
        },
      ];
    });

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "tools",
        "commands",
        "inspect",
        "example",
        "--json",
        "--plugin-descriptors",
      ]);
    });

    expect(forceStderrSnapshots).toEqual([true]);
    expect(JSON.parse(output).pluginCommands).toHaveLength(1);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes plugin logs away from Markdown output", async () => {
    const forceStderrSnapshots: boolean[] = [];
    loadPluginCliDescriptorEntriesMock.mockImplementationOnce(async () => {
      forceStderrSnapshots.push(loggingState.forceConsoleToStderr);
      return [];
    });

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "tools",
        "commands",
        "list",
        "--markdown",
        "--plugin-descriptors",
      ]);
    });

    expect(forceStderrSnapshots).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("fails instead of emitting an incomplete inventory when plugin loading fails", async () => {
    loadPluginCliDescriptorEntriesMock.mockRejectedValueOnce(
      new Error("Failed to load plugin CLI descriptor metadata: example-plugin: register failed"),
    );

    const output = await captureStdout(async () => {
      await expect(
        createProgram().parseAsync([
          "node",
          "openclaw",
          "tools",
          "commands",
          "list",
          "--json",
          "--plugin-descriptors",
        ]),
      ).rejects.toThrow("Failed to load plugin CLI descriptor metadata");
    });

    expect(output).toBe("");
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
