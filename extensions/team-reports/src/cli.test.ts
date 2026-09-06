import { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTeamReportsCli } from "./cli.js";

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>();
  return { ...original, callGatewayFromCli: vi.fn() };
});

function program(): Command {
  const command = new Command().exitOverride();
  registerTeamReportsCli({ program: command });
  return command;
}

const stdoutWrite = vi.fn<typeof process.stdout.write>(() => true);

beforeEach(() => {
  vi.mocked(callGatewayFromCli).mockReset();
  stdoutWrite.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(stdoutWrite);
});
afterEach(() => vi.restoreAllMocks());

describe("Team Reports CLI", () => {
  it("routes reads through the Gateway with read scope and prints Markdown unchanged", async () => {
    vi.mocked(callGatewayFromCli).mockResolvedValue({
      markdown: "# Team activity\n\nA useful report.\n",
    });
    await program().parseAsync(
      ["team-reports", "show", "day", "2026-08-20", "--markdown", "--url", "ws://127.0.0.1:12345"],
      { from: "user" },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "team-reports.get",
      expect.objectContaining({ url: "ws://127.0.0.1:12345" }),
      { period: "day", key: "2026-08-20", format: "markdown" },
      { mode: "cli", scopes: ["operator.read"] },
    );
    expect(stdoutWrite).toHaveBeenCalledWith("# Team activity\n\nA useful report.\n");
  });

  it("requests admin scope for generation and returns the run id as JSON", async () => {
    vi.mocked(callGatewayFromCli).mockResolvedValue({ runId: "run-fixture" });
    await program().parseAsync(["team-reports", "generate", "--date", "2026-08-20", "--json"], {
      from: "user",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "team-reports.generate",
      expect.objectContaining({ json: true }),
      { period: "day", date: "2026-08-20" },
      { mode: "cli", scopes: ["operator.admin"] },
    );
    expect(stdoutWrite).toHaveBeenCalledWith('{\n  "runId": "run-fixture"\n}\n');
  });

  it("rejects invalid calendar dates before issuing a Gateway mutation", async () => {
    await expect(
      program().parseAsync(["team-reports", "generate", "--date", "2026-02-30"], { from: "user" }),
    ).rejects.toThrow();
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
