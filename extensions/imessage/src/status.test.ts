// Imessage tests cover status plugin behavior.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import { probeIMessage, probeIMessagePrivateApi } from "./probe.js";
import { createIMessageSetupWizardProxy } from "./setup-core.js";
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
const setupToolsMocks = vi.hoisted(() => ({
  detectBinary: vi.fn(async () => false),
  formatDocsLink: vi.fn((path: string) => path),
}));
const installIMessageCliMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>()),
  ...setupToolsMocks,
}));

vi.mock("./install-imsg.js", () => ({
  installIMessageCli: installIMessageCliMock,
}));

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal?: string) => {
    child.killed = true;
    child.emit("close", 0, signal ?? null);
    return true;
  };
  return child;
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  }
}

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
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient();
    const internals = client as unknown as {
      handleLine: (line: string) => void;
      buildCloseError: (code: number | null, signal: NodeJS.Signals | null) => Error;
    };

    internals.handleLine(
      "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );

    expect(internals.buildCloseError(1, null).message).toBe(
      "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );
  });

  it.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ])(
    "frames stdout on LF only so raw %s inside JSON strings stays intact",
    async (_, separator) => {
      const { IMessageRpcClient } = await import("./client.js");
      const client = new IMessageRpcClient();
      const internals = client as unknown as {
        handleStdoutChunk: (chunk: Buffer | string) => void;
        pending: Map<
          string,
          {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
          }
        >;
      };
      const result = new Promise((resolve, reject) => {
        internals.pending.set("1", { resolve, reject });
      });
      const text = `line one${separator}line two`;
      const payload = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { messages: [{ text }] },
      })}\n`;
      const bytes = Buffer.from(payload, "utf8");
      const separatorIndex = bytes.indexOf(Buffer.from(separator, "utf8"));

      internals.handleStdoutChunk(bytes.subarray(0, separatorIndex + 1));
      internals.handleStdoutChunk(bytes.subarray(separatorIndex + 1));

      await expect(result).resolves.toEqual({
        messages: [{ text }],
      });
    },
  );

  it("handles multiple LF-delimited stdout responses in one chunk", async () => {
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient();
    const internals = client as unknown as {
      handleStdoutChunk: (chunk: Buffer | string) => void;
      pending: Map<
        string,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
        }
      >;
    };
    const first = new Promise((resolve, reject) => {
      internals.pending.set("1", { resolve, reject });
    });
    const second = new Promise((resolve, reject) => {
      internals.pending.set("2", { resolve, reject });
    });

    internals.handleStdoutChunk(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: "first" } })}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { ok: "second" },
      })}\n`,
    );

    await expect(first).resolves.toEqual({ ok: "first" });
    await expect(second).resolves.toEqual({ ok: "second" });
  });

  it("ignores stdout from a stale child after stop so late notifications cannot leak (#89830)", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const onNotification = vi.fn();
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient({ onNotification });

    await client.start();
    await client.stop();

    // A not-yet-exited imsg child emits a complete notification after stop().
    // The `this.child !== child` guard must drop it before handleStdoutChunk.
    child.stdout.write('{"jsonrpc":"2.0","method":"messages.changed","params":{}}\n');

    expect(onNotification).not.toHaveBeenCalled();
  });
});

describe("imessage setup status", () => {
  beforeEach(() => {
    setupToolsMocks.detectBinary.mockClear();
    installIMessageCliMock.mockReset();
  });

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

  it("setup status explains how to install imsg when the binary is missing", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {},
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain(
      "Install imsg on the Messages Mac: brew install steipete/tap/imsg",
    );
  });

  it("prepare offers to install imsg and returns the installed cliPath", async () => {
    setupToolsMocks.detectBinary.mockResolvedValueOnce(false);
    installIMessageCliMock.mockResolvedValueOnce({
      ok: true,
      cliPath: "/opt/homebrew/bin/imsg",
      version: "0.13.0",
    });
    const confirm = vi.fn(async () => true);
    const note = vi.fn(async () => {});

    const result = await withPlatform("darwin", () =>
      runSetupWizardPrepare({
        prepare: imessageSetupWizard.prepare,
        cfg: { channels: { imessage: {} } },
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm, note }),
      }),
    );

    expect(confirm).toHaveBeenCalledWith({
      message: "imsg not found. Install now?",
      initialValue: true,
    });
    expect(installIMessageCliMock).toHaveBeenCalledWith(expect.anything(), { upgrade: false });
    expect(note).toHaveBeenCalledWith("Installed imsg at /opt/homebrew/bin/imsg", "iMessage");
    expect(result).toEqual({
      credentialValues: {
        cliPath: "/opt/homebrew/bin/imsg",
      },
    });
  });

  it("setup status preserves an explicit PATH-based imsg wrapper", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "imsg",
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain(
      "imsg command not found (imsg). Check the configured cliPath or wrapper.",
    );
  });

  it("prepare offers to update Homebrew-managed imsg paths", async () => {
    setupToolsMocks.detectBinary.mockResolvedValueOnce(true);
    installIMessageCliMock.mockResolvedValueOnce({
      ok: true,
      cliPath: "/opt/homebrew/bin/imsg",
      version: "0.13.1",
    });
    const confirm = vi.fn(async () => true);
    const note = vi.fn(async () => {});

    const result = await withPlatform("darwin", () =>
      runSetupWizardPrepare({
        prepare: imessageSetupWizard.prepare,
        cfg: {
          channels: {
            imessage: {
              cliPath: "/opt/homebrew/bin/imsg",
            },
          },
        } as never,
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm, note }),
      }),
    );

    expect(confirm).toHaveBeenCalledWith({
      message: "imsg detected. Reinstall/update now?",
      initialValue: false,
    });
    expect(installIMessageCliMock).toHaveBeenCalledWith(expect.anything(), { upgrade: true });
    expect(result).toEqual({
      credentialValues: {
        cliPath: "/opt/homebrew/bin/imsg",
      },
    });
  });

  it("setup wizard proxy delegates imsg install preparation", async () => {
    setupToolsMocks.detectBinary.mockResolvedValueOnce(false);
    installIMessageCliMock.mockResolvedValueOnce({
      ok: true,
      cliPath: "/opt/homebrew/bin/imsg",
      version: "0.13.0",
    });
    const proxy = createIMessageSetupWizardProxy(async () => imessageSetupWizard);
    const confirm = vi.fn(async () => true);

    const result = await withPlatform("darwin", () =>
      runSetupWizardPrepare({
        prepare: proxy.prepare,
        cfg: { channels: { imessage: {} } },
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm }),
      }),
    );

    expect(confirm).toHaveBeenCalledWith({
      message: "imsg not found. Install now?",
      initialValue: true,
    });
    expect(result).toEqual({
      credentialValues: {
        cliPath: "/opt/homebrew/bin/imsg",
      },
    });
  });

  it("prepare preserves custom imsg cliPath values", async () => {
    const confirm = vi.fn(async () => true);

    const result = await withPlatform("darwin", () =>
      runSetupWizardPrepare({
        prepare: imessageSetupWizard.prepare,
        cfg: {
          channels: {
            imessage: {
              cliPath: "ssh imessage-host imsg",
            },
          },
        } as never,
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm }),
      }),
    );

    expect(result).toBeUndefined();
    expect(setupToolsMocks.detectBinary).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(installIMessageCliMock).not.toHaveBeenCalled();
  });

  it("prepare preserves explicit PATH-based imsg wrappers", async () => {
    const confirm = vi.fn(async () => true);

    const result = await withPlatform("darwin", () =>
      runSetupWizardPrepare({
        prepare: imessageSetupWizard.prepare,
        cfg: {
          channels: {
            imessage: {
              cliPath: "imsg",
            },
          },
        } as never,
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm }),
      }),
    );

    expect(result).toBeUndefined();
    expect(setupToolsMocks.detectBinary).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(installIMessageCliMock).not.toHaveBeenCalled();
  });

  it("prepare skips automatic imsg install on non-macOS hosts", async () => {
    const confirm = vi.fn(async () => true);

    const result = await withPlatform("linux", () =>
      runSetupWizardPrepare({
        prepare: imessageSetupWizard.prepare,
        cfg: { channels: { imessage: {} } },
        options: { allowIMessageInstall: true },
        prompter: createTestWizardPrompter({ confirm }),
      }),
    );

    expect(result).toBeUndefined();
    expect(setupToolsMocks.detectBinary).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(installIMessageCliMock).not.toHaveBeenCalled();
  });

  it("prepare skips imsg install prompts unless explicitly allowed", async () => {
    const confirm = vi.fn(async () => true);

    const result = await runSetupWizardPrepare({
      prepare: imessageSetupWizard.prepare,
      cfg: { channels: { imessage: {} } },
      prompter: createTestWizardPrompter({ confirm }),
    });

    expect(result).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(installIMessageCliMock).not.toHaveBeenCalled();
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    expect(result.error).toContain("brew update && brew upgrade imsg");
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("explains how to install imsg when the default binary is missing", async () => {
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(false);
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    const result = await probeIMessage(1000, { platform: "darwin" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "imsg not found (imsg). Install imsg on the Messages Mac: brew install steipete/tap/imsg",
    );
    expect(processRuntime.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("explains how to fix an explicit PATH-based imsg wrapper", async () => {
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(false);
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    const result = await probeIMessage(1000, { cliPath: "imsg", platform: "darwin" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "imsg command not found (imsg). Check the configured iMessage cliPath or wrapper.",
    );
    expect(processRuntime.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("explains how to fix a missing custom imsg wrapper", async () => {
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(false);
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    const result = await probeIMessage(1000, { cliPath: "/usr/local/bin/imsg-wrapper" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "imsg command not found (/usr/local/bin/imsg-wrapper). Check the configured iMessage cliPath or wrapper.",
    );
    expect(processRuntime.runCommandWithTimeout).not.toHaveBeenCalled();
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

  it("propagates imsg's status message when advanced features are unavailable", async () => {
    const note =
      "System Integrity Protection (SIP) is enabled.\nAdvanced IMCore features are intentionally disabled.";
    vi.spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          advanced_features: false,
          v2_ready: false,
          selectors: {},
          rpc_methods: ["chats.list"],
          message: note,
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })
      .mockResolvedValueOnce({
        stdout: "send-rich --help",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });

    await expect(probeIMessagePrivateApi("imsg-status-message-test", 1000)).resolves.toMatchObject({
      available: false,
      statusMessage: note,
    });
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
