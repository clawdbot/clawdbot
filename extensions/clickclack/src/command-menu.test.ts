import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNativeCommandSpecsForConfig: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/native-command-registry", () => ({
  listNativeCommandSpecsForConfig: mocks.listNativeCommandSpecsForConfig,
}));

import { syncClickClackCommandMenu } from "./command-menu.js";
import type { createClickClackClient } from "./http-client.js";
import type { CoreConfig } from "./types.js";

function nativeCommand(
  name: string,
  options: Partial<Omit<NativeCommandSpec, "name">> = {},
): NativeCommandSpec {
  return {
    name,
    description: options.description ?? `Run ${name}`,
    acceptsArgs: options.acceptsArgs ?? false,
    ...options,
  };
}

type CommandMenuEntry = {
  command: string;
  description: string;
  args_hint: string;
};

async function syncNativeCommands(
  specs: NativeCommandSpec[],
  log?: NonNullable<Parameters<typeof syncClickClackCommandMenu>[0]["log"]>,
): Promise<CommandMenuEntry[]> {
  const setBotCommands = vi.fn().mockResolvedValue([]);
  mocks.listNativeCommandSpecsForConfig.mockReturnValue(specs);

  await syncClickClackCommandMenu({
    cfg: {} as CoreConfig,
    client: { setBotCommands } as unknown as ReturnType<typeof createClickClackClient>,
    log,
  });

  expect(setBotCommands).toHaveBeenCalledTimes(1);
  return setBotCommands.mock.calls[0]?.[0] as CommandMenuEntry[];
}

describe("ClickClack command menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps native commands to the bounded ClickClack menu contract", async () => {
    const warn = vi.fn();
    const longDescription = "\u{1F642}".repeat(101);
    const commands = await syncNativeCommands(
      [
        nativeCommand("Deploy-Now", {
          description: `  ${longDescription}  `,
          acceptsArgs: true,
          args: [
            { name: "target", description: "Target", type: "string", required: true },
            { name: "message", description: "Message", type: "string" },
          ],
        }),
        nativeCommand("deploy-now", { description: "Duplicate loses" }),
        nativeCommand("shortcut", { isAlias: true }),
        nativeCommand("bad name"),
        nativeCommand("also/bad"),
        nativeCommand("status", { description: "   ", acceptsArgs: true }),
        nativeCommand("noargs"),
        nativeCommand("long-hint", {
          args: Array.from({ length: 20 }, (_, index) => ({
            name: `argument${index}`,
            description: "Argument",
            type: "string" as const,
            required: index === 0,
          })),
        }),
      ],
      { warn },
    );

    expect(commands).toHaveLength(4);
    expect(commands[0]).toEqual({
      command: "deploy-now",
      description: expect.any(String),
      args_hint: "<target> [message]",
    });
    expect(Array.from(commands[0]?.description ?? "")).toHaveLength(100);
    expect(commands[1]).toEqual({
      command: "status",
      description: "status",
      args_hint: "[args]",
    });
    expect(commands[2]).toEqual({
      command: "noargs",
      description: "Run noargs",
      args_hint: "",
    });
    expect(Array.from(commands[3]?.args_hint ?? "")).toHaveLength(100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'ClickClack command menu skipped invalid native command names: "bad name", "also/bad"',
    );
  });

  it("keeps the first 100 unique normalized commands", async () => {
    const specs = Array.from({ length: 101 }, (_, index) => nativeCommand(`command${index}`));

    const commands = await syncNativeCommands(specs);

    expect(commands).toHaveLength(100);
    expect(commands[0]?.command).toBe("command0");
    expect(commands[99]?.command).toBe("command99");
  });

  it("returns an empty overwrite for an empty native catalog", async () => {
    await expect(syncNativeCommands([])).resolves.toEqual([]);
  });

  it("sources the catalog from the ClickClack native command registry", async () => {
    const cfg = {} as CoreConfig;
    const setBotCommands = vi.fn().mockResolvedValue([]);
    mocks.listNativeCommandSpecsForConfig.mockReturnValue([
      nativeCommand("status", { acceptsArgs: true }),
    ]);

    await syncClickClackCommandMenu({
      cfg,
      client: { setBotCommands } as unknown as ReturnType<typeof createClickClackClient>,
    });

    expect(mocks.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(cfg, {
      provider: "clickclack",
    });
    expect(setBotCommands).toHaveBeenCalledWith([
      {
        command: "status",
        description: "Run status",
        args_hint: "[args]",
      },
    ]);
  });
});
