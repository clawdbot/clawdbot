import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/meeting-runtime");
  vi.resetModules();
});

describe("Teams meetings CLI output mode", () => {
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
      id: "teams-meetings",
      name: "Microsoft Teams meetings",
      description: "Microsoft Teams meetings CLI metadata",
    });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      descriptors: [
        {
          name: "teamsmeetings",
          description: "Join and manage Microsoft Teams meeting guests",
          hasSubcommands: true,
          machineOutput: expect.any(Function),
        },
      ],
    });
    const program = new Command();
    for (const [register] of registerCli.mock.calls) {
      await register({ program, parentPath: [], config: {}, logger: api.logger });
    }
    expect(program.commands).toEqual([]);

    const isMachineOutput = metadata.descriptor.machineOutput;
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "teamsmeetings", "status"],
      }),
    ).toBe(true);
    expect(isMachineOutput({ argv: ["node", "openclaw", "teamsmeetings"] })).toBe(false);
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "teamsmeetings", "--log-level", "debug", "future-action"],
      }),
    ).toBe(true);
  });
});
