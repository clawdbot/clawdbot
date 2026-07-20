import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCliMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));

import { registerTeamsMeetingsCli } from "./cli.js";
import { resolveTeamsMeetingsConfig } from "./config.js";

const MEETING_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_cli_probe%40thread.v2/0";

afterEach(() => {
  callGatewayFromCliMock.mockReset();
  vi.restoreAllMocks();
});

function createProgram(): Command {
  const program = new Command();
  registerTeamsMeetingsCli({ program, config: resolveTeamsMeetingsConfig({}) });
  return program;
}

describe("Microsoft Teams meetings CLI", () => {
  it("exposes the same bounded timeout on both live probes", () => {
    const root = createProgram().commands.find((command) => command.name() === "teamsmeetings");

    for (const name of ["test-speech", "test-listen"]) {
      const probe = root?.commands.find((command) => command.name() === name);
      expect(probe?.options.map((option) => option.long)).toContain("--timeout-ms");
    }
  });

  it("forwards the listening probe timeout to the gateway operation", async () => {
    callGatewayFromCliMock.mockResolvedValue({ ok: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["teamsmeetings", "test-listen", MEETING_URL, "--timeout-ms", "90000"],
      { from: "user" },
    );

    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "teamsmeetings.testListen",
      { json: true, timeout: "120000" },
      { url: MEETING_URL, timeoutMs: 90_000 },
      { progress: false, scopes: ["operator.admin"] },
    );
  });
});
