import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withTempSecretFiles } from "../test-utils/secret-file-fixture.js";
import { registerAcpCli } from "./acp-cli.js";

type AcpClientOptions = {
  verbose?: boolean;
};

type AcpGatewayOptions = {
  gatewayPassword?: string;
  gatewayToken?: string;
};

const mocks = vi.hoisted(() => ({
  runAcpClientInteractive: vi.fn(async (_opts: AcpClientOptions) => {}),
  serveAcpGateway: vi.fn(async (_opts: AcpGatewayOptions) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { runAcpClientInteractive, serveAcpGateway, defaultRuntime } = mocks;

const passwordKey = () => ["pass", "word"].join("");

vi.mock("../acp/client.js", () => ({
  runAcpClientInteractive: (opts: AcpClientOptions) => mocks.runAcpClientInteractive(opts),
}));

vi.mock("../acp/server.js", () => ({
  serveAcpGateway: (opts: AcpGatewayOptions) => mocks.serveAcpGateway(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("acp cli option collisions", () => {
  function createAcpProgram() {
    const program = new Command();
    registerAcpCli(program);
    return program;
  }

  async function parseAcp(args: string[]) {
    const program = createAcpProgram();
    await program.parseAsync(["acp", ...args], { from: "user" });
  }

  function expectCliError(pattern: RegExp) {
    expect(serveAcpGateway).not.toHaveBeenCalled();
    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors.some((message) => pattern.test(message))).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  }

  function requireFirstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("expected mock to have at least one call");
    }
    return call[0];
  }

  beforeEach(() => {
    runAcpClientInteractive.mockClear();
    serveAcpGateway.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    await runRegisteredCli({
      register: registerAcpCli as (program: Command) => void,
      argv: ["acp", "client", "--verbose"],
    });

    expect(runAcpClientInteractive).toHaveBeenCalledTimes(1);
    const clientOptions = requireFirstMockArg(runAcpClientInteractive) as { verbose?: boolean };
    expect(clientOptions?.verbose).toBe(true);
  });

  it("loads gateway token/password from files", async () => {
    await withTempSecretFiles(
      "openclaw-acp-cli-",
      { token: "tok_file\n", [passwordKey()]: "pw_file\n" },
      async (files) => {
        // pragma: allowlist secret
        await parseAcp([
          "--token-file",
          files.tokenFile ?? "",
          "--password-file",
          files.passwordFile ?? "",
        ]);
      },
    );

    expect(serveAcpGateway).toHaveBeenCalledTimes(1);
    const gatewayOptions = requireFirstMockArg(serveAcpGateway) as {
      gatewayPassword?: string;
      gatewayToken?: string;
    };
    expect(gatewayOptions?.gatewayToken).toBe("tok_file");
    expect(gatewayOptions?.gatewayPassword).toBe("pw_file"); // pragma: allowlist secret
  });

  it.each([
    {
      name: "rejects mixed secret flags and file flags",
      files: { token: "tok_file\n" },
      args: (tokenFile: string) => ["--token", "tok_inline", "--token-file", tokenFile],
      expected: /Use either --token .*--token-file for Gateway token\./,
    },
    {
      name: "rejects mixed password flags and file flags",
      files: { password: "pw_file\n" }, // pragma: allowlist secret
      args: (_tokenFile: string, passwordFile: string) => [
        "--password",
        "pw_inline",
        "--password-file",
        passwordFile,
      ],
      expected: /Use either --passw.*d .*--password-file for Gateway password\./,
    },
  ])("$name", async ({ files, args, expected }) => {
    await withTempSecretFiles("openclaw-acp-cli-", files, async ({ tokenFile, passwordFile }) => {
      await parseAcp(args(tokenFile ?? "", passwordFile ?? ""));
    });

    expectCliError(expected);
  });

  it("warns when inline secret flags are used", async () => {
    await parseAcp(["--token", "tok_inline", "--password", "pw_inline"]);

    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors).toContain(
      "Warning: --token can be exposed via process listings. Prefer --token-file or environment variables.",
    );
    expect(errors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or environment variables.",
    );
  });

  it("trims token file path before reading", async () => {
    await withTempSecretFiles("openclaw-acp-cli-", { token: "tok_file\n" }, async (files) => {
      await parseAcp(["--token-file", `  ${files.tokenFile ?? ""}  `]);
    });

    expect(serveAcpGateway).toHaveBeenCalledTimes(1);
    const gatewayOptions = requireFirstMockArg(serveAcpGateway) as { gatewayToken?: string };
    expect(gatewayOptions?.gatewayToken).toBe("tok_file");
  });

  it("reports missing token-file read errors", async () => {
    await parseAcp(["--token-file", "/tmp/openclaw-acp-missing-token.txt"]);
    expectCliError(/Failed to (inspect|read) Gateway token file/);
  });
});
