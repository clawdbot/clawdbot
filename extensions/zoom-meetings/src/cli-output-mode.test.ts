import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/meeting-runtime");
  vi.resetModules();
});

describe("Zoom meetings CLI output mode", () => {
  it("loads and registers metadata without the meeting runtime", async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/meeting-runtime", () => {
      throw new Error("CLI metadata must not load the meeting runtime");
    });
    const { default: metadata } = await import("../cli-metadata.js");
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const api = createTestPluginApi({ registerCli });
    metadata.register(api);

    expect(metadata).toMatchObject({
      id: "zoom-meetings",
      name: "Zoom meetings",
      description: "Zoom meetings CLI metadata",
    });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      descriptors: [
        {
          name: "zoommeetings",
          description: "Join and manage Zoom meeting guests",
          hasSubcommands: true,
          machineOutput: expect.any(Function),
        },
      ],
    });
    const program = new Command();
    await registerCli.mock.calls[0][0]({ program, parentPath: [], config: {}, logger: api.logger });
    expect(program.commands).toEqual([]);

    const isMachineOutput = metadata.descriptor.machineOutput;
    expect(isMachineOutput({ argv: ["node", "openclaw", "zoommeetings", "status"] })).toBe(true);
    expect(isMachineOutput({ argv: ["node", "openclaw", "zoommeetings"] })).toBe(false);
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "zoommeetings", "--log-level", "debug", "future-action"],
      }),
    ).toBe(true);
  });
});
