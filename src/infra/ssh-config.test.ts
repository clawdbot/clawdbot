// Tests SSH config parsing and canonical command execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  parseSshConfigOutput,
  resolveSshConfig,
  SSH_CONFIG_OUTPUT_MAX_CHARS,
} from "./ssh-config.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

const runCommandMock = vi.mocked(runCommandWithTimeout);
const sshOutput = [
  "user steipete",
  "hostname peters-mac-studio-1.sheep-coho.ts.net",
  "port 2222",
  "identityfile none",
  "identityfile /tmp/id_ed25519",
  "",
].join("\n");

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof runCommandWithTimeout>>> = {},
): Awaited<ReturnType<typeof runCommandWithTimeout>> {
  return {
    stdout: sshOutput,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("ssh-config", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue(commandResult());
  });

  it("parses ssh -G output", () => {
    const parsed = parseSshConfigOutput(
      "user bob\nhostname example.com\nport 2222\nidentityfile none\nidentityfile /tmp/id\n",
    );
    expect(parsed).toEqual({
      user: "bob",
      host: "example.com",
      port: 2222,
      identityFiles: ["/tmp/id"],
    });
  });

  it("ignores invalid ports and blank lines", () => {
    const parsed = parseSshConfigOutput(
      "user bob\nhostname example.com\nport not-a-number\nidentityfile none\nidentityfile   \n",
    );
    expect(parsed.port).toBeUndefined();
    expect(parsed.identityFiles).toStrictEqual([]);
    expect(parseSshConfigOutput("hostname example.com\nport 2222abc\n").port).toBeUndefined();
    expect(parseSshConfigOutput("hostname example.com\nport 70000\n").port).toBeUndefined();
  });

  it("resolves ssh config through the canonical command wrapper", async () => {
    await expect(resolveSshConfig({ user: "me", host: "alias", port: 22 })).resolves.toEqual({
      user: "steipete",
      host: "peters-mac-studio-1.sheep-coho.ts.net",
      port: 2222,
      identityFiles: ["/tmp/id_ed25519"],
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      ["/usr/bin/ssh", "-G", "--", "me@alias"],
      expect.objectContaining({
        maxOutputBytes: SSH_CONFIG_OUTPUT_MAX_CHARS,
        outputCapture: "head",
        terminateOnOutputLimit: true,
      }),
    );
  });

  it("adds non-default port and trimmed identity arguments", async () => {
    await resolveSshConfig(
      { user: "me", host: "alias", port: 2022 },
      { identity: "  /tmp/custom_id  " },
    );
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual([
      "/usr/bin/ssh",
      "-G",
      "-p",
      "2022",
      "-i",
      "/tmp/custom_id",
      "--",
      "me@alias",
    ]);
  });

  it.each([
    commandResult({ code: 1 }),
    commandResult({ termination: "timeout", code: 124 }),
    commandResult({ outputLimitExceeded: true, termination: "signal", code: null }),
    commandResult({ stdout: "" }),
  ])("returns null for an unusable command result", async (result) => {
    runCommandMock.mockResolvedValueOnce(result);
    await expect(resolveSshConfig({ user: "me", host: "bad-host", port: 22 })).resolves.toBeNull();
  });

  it("returns null when command launch fails", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("spawn boom"));
    await expect(resolveSshConfig({ user: "me", host: "bad-host", port: 22 })).resolves.toBeNull();
  });
});
