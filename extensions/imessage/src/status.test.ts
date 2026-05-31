import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import { clearIMessagePrivateApiCache, probeIMessage, probeIMessagePrivateApi } from "./probe.js";
import { imessageSetupWizard } from "./setup-surface.js";
import { probeIMessageStatusAccount } from "./status-core.js";

const getIMessageSetupStatus = createPluginSetupWizardStatus({
  id: "imessage",
  meta: {
    label: "iMessage",
  },
  setupWizard: imessageSetupWizard,
} as never);

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("createIMessageRpcClient", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    vi.stubEnv("VITEST", "true");
  });

  it("refuses to spawn imsg rpc in test environments", async () => {
    const { createIMessageRpcClient } = await import("./client.js");
    await expect(createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("promotes Full Disk Access rpc banners to the public probe error", async () => {
    const { IMessageRpcClient, PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR } =
      await import("./client.js");
    const client = new IMessageRpcClient();
    const internals = client as unknown as {
      handleLine: (line: string) => void;
      buildCloseError: (code: number | null, signal: NodeJS.Signals | null) => Error;
    };

    internals.handleLine(
      "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );

    expect(internals.buildCloseError(1, null).message).toBe(PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR);
  });
});

describe("imessage setup status", () => {
  it("does not inherit configured state from a sibling account", async () => {
    const result = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      },
      accountOverrides: {
        imessage: "work",
      },
    });

    expect(result.configured).toBe(false);
    expect(result.statusLines).toContain("iMessage: needs setup");
  });

  it("uses configured defaultAccount for omitted setup status cliPath", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "/tmp/root-imsg",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            defaultAccount: "work",
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toContain("iMessage: needs setup");
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "/tmp/root-imsg",
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
          },
        },
      } as never,
      accountOverrides: { imessage: "work" },
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearIMessagePrivateApiCache();
    spawnMock.mockClear();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: 'unknown command "rpc" for "imsg"',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("drops cached rpc support when the current clock is not a valid date timestamp", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValueOnce(Number.NaN)
      .mockReturnValue(1_700_000_000_000);
    const runCommand = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValueOnce({
        stdout: "",
        stderr: 'unknown command "rpc" for "imsg"',
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      })
      .mockResolvedValueOnce({
        stdout: "rpc help",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          advanced_features: true,
          v2_ready: true,
          selectors: {},
          rpc_methods: ["chats.list"],
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })
      .mockResolvedValueOnce({
        stdout: "send-rich --file",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
    vi.spyOn(clientModule, "createIMessageRpcClient").mockResolvedValue({
      request: vi.fn().mockResolvedValue({ chats: [] }),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    await expect(probeIMessage(1000, { cliPath: "imsg-invalid-rpc-clock" })).resolves.toMatchObject(
      {
        ok: false,
        fatal: true,
      },
    );
    await expect(probeIMessage(1000, { cliPath: "imsg-invalid-rpc-clock" })).resolves.toMatchObject(
      {
        ok: true,
      },
    );

    expect(runCommand).toHaveBeenNthCalledWith(1, ["imsg-invalid-rpc-clock", "rpc", "--help"], {
      timeoutMs: 1000,
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, ["imsg-invalid-rpc-clock", "rpc", "--help"], {
      timeoutMs: 1000,
    });
  });

  it("does not cache rpc support when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const runCommand = vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: 'unknown command "rpc" for "imsg"',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(
      probeIMessage(1000, { cliPath: "imsg-overflow-rpc-clock" }),
    ).resolves.toMatchObject({
      ok: false,
      fatal: true,
    });
    await expect(
      probeIMessage(1000, { cliPath: "imsg-overflow-rpc-clock" }),
    ).resolves.toMatchObject({
      ok: false,
      fatal: true,
    });

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("does not cache unavailable private API status when the process clock is invalid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const runCommand = vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: "bridge unavailable",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(
      probeIMessagePrivateApi("imsg-invalid-private-status-clock", 1000),
    ).resolves.toMatchObject({
      available: false,
    });
    await expect(
      probeIMessagePrivateApi("imsg-invalid-private-status-clock", 1000),
    ).resolves.toMatchObject({
      available: false,
    });

    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it("fails fast for default local imsg probes on non-mac hosts", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    const result = await probeIMessage(1000, { cliPath: "imsg", platform: "linux" });

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/macOS/i);
    expect(result.error).toMatch(/SSH wrapper/i);
    expect(setupRuntime.detectBinary).not.toHaveBeenCalled();
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("status probe uses account-scoped cliPath and dbPath", async () => {
    const probeSpy = vi.spyOn(channelRuntimeModule, "probeIMessageAccount").mockResolvedValue({
      ok: true,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    } as Awaited<ReturnType<typeof channelRuntimeModule.probeIMessageAccount>>);

    const cfg = {
      channels: {
        imessage: {
          cliPath: "imsg-root",
          dbPath: "/tmp/root-db",
          accounts: {
            work: {
              cliPath: "imsg-work",
              dbPath: "/tmp/work-db",
            },
          },
        },
      },
    } as const;
    const account = resolveIMessageAccount({ cfg, accountId: "work" });

    await probeIMessageStatusAccount({
      account,
      timeoutMs: 2500,
      probeIMessageAccount: channelRuntimeModule.probeIMessageAccount,
    });

    expect(probeSpy).toHaveBeenCalledWith({
      timeoutMs: 2500,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    });
  });
});
