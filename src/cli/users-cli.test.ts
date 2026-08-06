import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUsersCli, testApi } from "./users-cli.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCli }));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayFromCli.mockReset();
});

describe("registerUsersCli", () => {
  it("reports the authoritative linked profile and uses the admin gateway method", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callGatewayFromCli.mockResolvedValue({
      profile: {
        id: "p-1\nshadow",
        displayName: "Ada\tadmin\u001b[2J",
        emails: ["ada@example.com\nnext@example.com"],
      },
    });
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "link-email",
      "Ada@example.com",
      "--to",
      "p-1",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "users.linkEmail",
      expect.objectContaining({ to: "p-1" }),
      { email: "Ada@example.com", targetProfileId: "p-1" },
      { scopes: ["operator.admin"] },
    );
    expect(output).toHaveBeenCalledWith(
      "p-1\\nshadow\tAda\\tadmin\tada@example.com\\nnext@example.com\n",
    );
  });

  it("reports an empty user profile list", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callGatewayFromCli.mockResolvedValue({ profiles: [] });
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync(["node", "openclaw", "users", "list"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "users.list",
      expect.any(Object),
      {},
      { scopes: ["operator.read"] },
    );
    expect(output).toHaveBeenCalledWith("No user profiles found.\n");
  });

  it("preserves the empty profile list JSON response", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callGatewayFromCli.mockResolvedValue({ profiles: [] });
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync(["node", "openclaw", "users", "list", "--json"]);

    expect(output).toHaveBeenCalledWith('{\n  "profiles": []\n}\n');
  });

  it("prints the link result as JSON when requested", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callGatewayFromCli.mockResolvedValue({ profile: { id: "p-1" } });
    const program = new Command().exitOverride();
    registerUsersCli(program);

    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "link-email",
      "Ada@example.com",
      "--to",
      "p-1",
      "--json",
    ]);

    expect(output).toHaveBeenCalledWith('{\n  "profile": {\n    "id": "p-1"\n  }\n}\n');
  });

  it("escapes untrusted profile fields in human list output", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    testApi.writeUsersList(
      {
        profiles: [
          {
            id: "p-1",
            displayName: "Ada\n\t\u001b[2J\u0007",
            emails: ["ada@example.com\nnext@example.com"],
          },
        ],
      },
      false,
    );

    expect(output).toHaveBeenCalledWith("p-1\tAda\\n\\t\tada@example.com\\nnext@example.com\n");
  });
});
