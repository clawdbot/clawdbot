/** Tests SecretRef provider resolution for env, file, and exec sources. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  killPidIfAlive,
  readPidFile,
  waitForPidToExit,
  writeForkingNoOutputScript,
} from "../test-utils/process-tree.js";
import { INVALID_EXEC_SECRET_REF_IDS } from "../test-utils/secret-ref-test-vectors.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import {
  isMissingSecretRefResolutionError,
  resolveSecretRefString,
  resolveSecretRefValue,
  resolveSecretRefValues,
} from "./resolve.js";

async function writeSecureFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

describe("secret ref resolver", () => {
  const isWindows = process.platform === "win32";
  function itPosix(name: string, fn: () => Promise<void> | void) {
    it.skipIf(isWindows)(name, fn);
  }
  let fixtureRoot = "";
  let caseId = 0;
  let execProtocolV1ScriptPath = "";
  let execPlainScriptPath = "";
  let execProtocolV2ScriptPath = "";
  let execMissingIdScriptPath = "";
  let execInheritedErrorScriptPath = "";
  let execProviderErrorScriptPath = "";
  let execUnsafeProviderErrorScriptPath = "";
  let execInvalidJsonScriptPath = "";
  let execFastExitScriptPath = "";

  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir);
    return dir;
  };

  type ExecProviderConfig = {
    source: "exec";
    command: string;
    passEnv?: string[];
    jsonOnly?: boolean;
    allowSymlinkCommand?: boolean;
    trustedDirs?: string[];
    env?: Record<string, string>;
    args?: string[];
    timeoutMs?: number;
    noOutputTimeoutMs?: number;
  };
  type FileProviderConfig = {
    source: "file";
    path: string;
    mode: "json" | "singleValue";
    timeoutMs?: number;
    allowInsecurePath?: boolean;
  };

  function createExecProviderConfig(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
  ): ExecProviderConfig {
    return {
      source: "exec",
      command,
      passEnv: ["PATH"],
      ...overrides,
    };
  }

  async function resolveExecSecret(
    command: string,
    overrides: Partial<ExecProviderConfig> = {},
  ): Promise<string> {
    return resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "openai/api-key" },
      {
        config: {
          secrets: {
            providers: {
              execmain: createExecProviderConfig(command, overrides),
            },
          },
        },
      },
    );
  }

  function createFileProviderConfig(
    filePath: string,
    overrides: Partial<FileProviderConfig> = {},
  ): FileProviderConfig {
    return {
      source: "file",
      path: filePath,
      mode: "json",
      ...overrides,
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-resolve-"));
    const sharedExecDir = path.join(fixtureRoot, "shared-exec");
    await fs.mkdir(sharedExecDir, { recursive: true });

    execProtocolV1ScriptPath = path.join(sharedExecDir, "resolver-v1.sh");
    await writeSecureFile(
      execProtocolV1ScriptPath,
      [
        "#!/bin/sh",
        'printf \'{"protocolVersion":1,"values":{"openai/api-key":"value:openai/api-key"}}\'',
      ].join("\n"),
      0o700,
    );

    execPlainScriptPath = path.join(sharedExecDir, "resolver-plain.sh");
    await writeSecureFile(
      execPlainScriptPath,
      ["#!/bin/sh", "printf 'plain-secret'"].join("\n"),
      0o700,
    );

    execProtocolV2ScriptPath = path.join(sharedExecDir, "resolver-v2.sh");
    await writeSecureFile(
      execProtocolV2ScriptPath,
      ["#!/bin/sh", 'printf \'{"protocolVersion":2,"values":{"openai/api-key":"x"}}\''].join("\n"),
      0o700,
    );

    execMissingIdScriptPath = path.join(sharedExecDir, "resolver-missing-id.sh");
    await writeSecureFile(
      execMissingIdScriptPath,
      ["#!/bin/sh", 'printf \'{"protocolVersion":1,"values":{}}\''].join("\n"),
      0o700,
    );

    execInheritedErrorScriptPath = path.join(sharedExecDir, "resolver-inherited-error.sh");
    await writeSecureFile(
      execInheritedErrorScriptPath,
      [
        "#!/bin/sh",
        'printf \'{"protocolVersion":1,"values":{"toString":"resolved"},"errors":{}}\'',
      ].join("\n"),
      0o700,
    );

    execProviderErrorScriptPath = path.join(sharedExecDir, "resolver-error.sh");
    await writeSecureFile(
      execProviderErrorScriptPath,
      [
        "#!/bin/sh",
        'printf \'{"protocolVersion":1,"values":{},"errors":{"openai/api-key":{"code":"NOT_FOUND","message":"provider-private-detail-7f3c"}}}\'',
      ].join("\n"),
      0o700,
    );

    execUnsafeProviderErrorScriptPath = path.join(sharedExecDir, "resolver-unsafe-error.sh");
    await writeSecureFile(
      execUnsafeProviderErrorScriptPath,
      [
        "#!/bin/sh",
        'printf \'{"protocolVersion":1,"values":{},"errors":{"openai/api-key":{"code":"PROVIDERPRIVATEDETAIL9C2E"}}}\'',
      ].join("\n"),
      0o700,
    );

    execInvalidJsonScriptPath = path.join(sharedExecDir, "resolver-invalid-json.sh");
    await writeSecureFile(
      execInvalidJsonScriptPath,
      ["#!/bin/sh", "printf 'not-json'"].join("\n"),
      0o700,
    );

    execFastExitScriptPath = path.join(sharedExecDir, "resolver-fast-exit.sh");
    await writeSecureFile(execFastExitScriptPath, ["#!/bin/sh", "exit 0"].join("\n"), 0o700);
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("resolves env refs via implicit default env provider", async () => {
    const config: OpenClawConfig = {};
    const value = await resolveSecretRefString(
      { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      {
        config,
        env: { OPENAI_API_KEY: "sk-env-value" }, // pragma: allowlist secret
      },
    );
    expect(value).toBe("sk-env-value");
  });

  it("classifies only matching absent env refs as missing", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_API_KEY" } as const;
    const missingError = await resolveSecretRefValue(ref, { config: {}, env: {} }).catch(
      (error: unknown) => error,
    );

    expect(isMissingSecretRefResolutionError({ ref, error: missingError })).toBe(true);
    expect(
      isMissingSecretRefResolutionError({
        ref: { ...ref, id: "OTHER_API_KEY" },
        error: missingError,
      }),
    ).toBe(false);

    const policyError = await resolveSecretRefValue(ref, {
      config: {
        secrets: {
          providers: {
            default: { source: "env", allowlist: ["OTHER_API_KEY"] },
          },
        },
      },
      env: { MISSING_API_KEY: "test-missing-api-key" },
    }).catch((error: unknown) => error);
    expect(isMissingSecretRefResolutionError({ ref, error: policyError })).toBe(false);
  });

  it("classifies missing refs under a configured default provider alias", async () => {
    const ref = { source: "env", provider: "primary", id: "MISSING_API_KEY" } as const;
    const error = await resolveSecretRefValue(ref, {
      config: {
        secrets: {
          defaults: { env: "primary" },
          providers: { primary: { source: "env" } },
        },
      },
      env: {},
    }).catch((caught: unknown) => caught);

    expect(isMissingSecretRefResolutionError({ ref, error })).toBe(true);
  });

  it("does not rewrite an explicit default provider to a configured alias", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_API_KEY" } as const;
    const error = await resolveSecretRefValue(ref, {
      config: {
        secrets: {
          defaults: { env: "primary" },
          providers: { primary: { source: "env" } },
        },
      },
      env: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Secret provider "default" is not configured');
    expect(isMissingSecretRefResolutionError({ ref, error })).toBe(false);
  });

  itPosix("resolves file refs in json mode", async () => {
    const root = await createCaseDir("file");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(
      filePath,
      JSON.stringify({
        providers: {
          openai: {
            apiKey: "sk-file-value", // pragma: allowlist secret
          },
        },
      }),
    );

    const value = await resolveSecretRefString(
      { source: "file", provider: "filemain", id: "/providers/openai/apiKey" },
      {
        config: {
          secrets: {
            providers: {
              filemain: createFileProviderConfig(filePath),
            },
          },
        },
      },
    );
    expect(value).toBe("sk-file-value");
  });

  itPosix("classifies an out-of-bounds file pointer as a missing ref", async () => {
    const root = await createCaseDir("file-missing-index");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(filePath, JSON.stringify({ providers: [] }));
    const ref = { source: "file", provider: "filemain", id: "/providers/0" } as const;
    const error = await resolveSecretRefValue(ref, {
      config: {
        secrets: {
          providers: {
            filemain: createFileProviderConfig(filePath),
          },
        },
      },
    }).catch((caught: unknown) => caught);

    expect(isMissingSecretRefResolutionError({ ref, error })).toBe(true);
  });

  itPosix("resolves exec refs with protocolVersion 1 response", async () => {
    const value = await resolveExecSecret(execProtocolV1ScriptPath);
    expect(value).toBe("value:openai/api-key");
  });

  itPosix("surfaces bounded exec error codes without provider-supplied detail", async () => {
    const error = await resolveExecSecret(execProviderErrorScriptPath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Exec provider "execmain" failed for id "openai/api-key" (NOT_FOUND).',
    );
    expect((error as Error).message).not.toContain("provider-private-detail-7f3c");
  });

  itPosix(
    "classifies omitted and NOT_FOUND exec ids as missing but keeps other errors fail-closed",
    async () => {
      const ref = { source: "exec", provider: "execmain", id: "openai/api-key" } as const;
      const configFor = (command: string): OpenClawConfig => ({
        secrets: {
          providers: {
            execmain: createExecProviderConfig(command),
          },
        },
      });
      const omittedError = await resolveSecretRefValue(ref, {
        config: configFor(execMissingIdScriptPath),
      }).catch((error: unknown) => error);
      const missingError = await resolveSecretRefValue(ref, {
        config: configFor(execProviderErrorScriptPath),
      }).catch((error: unknown) => error);
      const providerError = await resolveSecretRefValue(ref, {
        config: configFor(execUnsafeProviderErrorScriptPath),
      }).catch((error: unknown) => error);

      expect(isMissingSecretRefResolutionError({ ref, error: omittedError })).toBe(true);
      expect(isMissingSecretRefResolutionError({ ref, error: missingError })).toBe(true);
      expect(isMissingSecretRefResolutionError({ ref, error: providerError })).toBe(false);
    },
  );

  itPosix("suppresses exec error codes outside the bounded format", async () => {
    const error = await resolveExecSecret(execUnsafeProviderErrorScriptPath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Exec provider "execmain" failed for id "openai/api-key".',
    );
    expect((error as Error).message).not.toContain("PROVIDERPRIVATEDETAIL9C2E");
  });

  itPosix("clamps oversized exec provider timeouts", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const value = await resolveExecSecret(execProtocolV1ScriptPath, {
      timeoutMs: Number.MAX_SAFE_INTEGER,
      noOutputTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(value).toBe("value:openai/api-key");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  itPosix("uses timeoutMs as the default no-output timeout for exec providers", async () => {
    const root = await createCaseDir("exec-delay");
    const scriptPath = path.join(root, "resolver-delay.sh");
    // Keep the fixture cheap to start so this stays deterministic under a busy test run.
    await writeSecureFile(
      scriptPath,
      [
        "#!/bin/sh",
        "sleep 0.03",
        'printf \'{"protocolVersion":1,"values":{"delayed":"ok"}}\'',
      ].join("\n"),
      0o700,
    );

    const value = await resolveSecretRefString(
      { source: "exec", provider: "execmain", id: "delayed" },
      {
        config: {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: scriptPath,
                passEnv: ["PATH"],
                timeoutMs: 1500,
              },
            },
          },
        },
      },
    );
    expect(value).toBe("ok");
  });

  itPosix("kills forked exec provider children on no-output timeout", async () => {
    const root = await createCaseDir("exec-fork-timeout");
    const scriptPath = await writeForkingNoOutputScript(root);
    const pidPath = path.join(root, "forked.pid");
    let childPid: number | undefined;
    const nativeSetTimeout = globalThis.setTimeout;
    const noOutputTimeouts: Array<() => void> = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 1_000) {
          noOutputTimeouts.push(() => callback(...args));
          return nativeSetTimeout(() => undefined, 60_000);
        }
        return nativeSetTimeout(callback, delay, ...args);
      });

    try {
      const resultPromise = resolveExecSecret(scriptPath, {
        env: { NODE_BINARY: process.execPath, PID_FILE: pidPath },
        // Preserve production-like startup headroom; the test fires the
        // re-armed timer only after the readiness byte arrives.
        noOutputTimeoutMs: 1_000,
        timeoutMs: 10_000,
      });
      await vi.waitFor(() => {
        expect(noOutputTimeouts.length).toBeGreaterThanOrEqual(2);
      });
      childPid = await readPidFile(pidPath);
      noOutputTimeouts.at(-1)?.();
      await expect(resultPromise).rejects.toThrow('Exec provider "execmain" produced no output');
      expect(await waitForPidToExit(childPid, 5_000)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      killPidIfAlive(childPid);
    }
  });

  itPosix("supports non-JSON single-value exec output when jsonOnly is false", async () => {
    const value = await resolveExecSecret(execPlainScriptPath, { jsonOnly: false });
    expect(value).toBe("plain-secret");
  });

  itPosix(
    "tolerates stdin write errors when exec provider exits before consuming a large request",
    async () => {
      const refs = Array.from({ length: 256 }, (_, index) => ({
        source: "exec" as const,
        provider: "execmain",
        id: `openai/${String(index).padStart(3, "0")}/${"x".repeat(240)}`,
      }));
      await expect(
        resolveSecretRefValues(refs, {
          config: {
            secrets: {
              providers: {
                execmain: {
                  source: "exec",
                  command: execFastExitScriptPath,
                },
              },
            },
          },
        }),
      ).rejects.toThrow('Exec provider "execmain" returned empty stdout.');
    },
  );

  itPosix("rejects symlink command paths unless allowSymlinkCommand is enabled", async () => {
    const root = await createCaseDir("exec-link-reject");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);

    await expect(resolveExecSecret(symlinkPath, { jsonOnly: false })).rejects.toThrow(
      "must not be a symlink",
    );
  });

  itPosix("allows symlink command paths when allowSymlinkCommand is enabled", async () => {
    const root = await createCaseDir("exec-link-allow");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);
    const trustedRoot = await fs.realpath(fixtureRoot);

    const value = await resolveExecSecret(symlinkPath, {
      jsonOnly: false,
      allowSymlinkCommand: true,
      trustedDirs: [trustedRoot],
    });
    expect(value).toBe("plain-secret");
  });

  itPosix(
    "handles Homebrew-style symlinked exec commands with args only when explicitly allowed",
    async () => {
      const root = await createCaseDir("homebrew");
      const binDir = path.join(root, "opt", "homebrew", "bin");
      const cellarDir = path.join(root, "opt", "homebrew", "Cellar", "node", "25.0.0", "bin");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(cellarDir, { recursive: true });

      const targetCommand = path.join(cellarDir, "node");
      const symlinkCommand = path.join(binDir, "node");
      await writeSecureFile(
        targetCommand,
        [
          "#!/bin/sh",
          'suffix="${1:-missing}"',
          'printf \'{"protocolVersion":1,"values":{"openai/api-key":"%s:openai/api-key"}}\' "$suffix"',
        ].join("\n"),
        0o700,
      );
      await fs.symlink(targetCommand, symlinkCommand);
      const trustedRoot = await fs.realpath(root);

      await expect(resolveExecSecret(symlinkCommand, { args: ["brew"] })).rejects.toThrow(
        "must not be a symlink",
      );

      const value = await resolveExecSecret(symlinkCommand, {
        args: ["brew"],
        allowSymlinkCommand: true,
        trustedDirs: [trustedRoot],
      });
      expect(value).toBe("brew:openai/api-key");
    },
  );

  itPosix("checks trustedDirs against resolved symlink target", async () => {
    const root = await createCaseDir("exec-link-trusted");
    const symlinkPath = path.join(root, "resolver-link.mjs");
    await fs.symlink(execPlainScriptPath, symlinkPath);

    await expect(
      resolveExecSecret(symlinkPath, {
        jsonOnly: false,
        allowSymlinkCommand: true,
        trustedDirs: [root],
      }),
    ).rejects.toThrow("outside trustedDirs");
  });

  itPosix("rejects exec refs when protocolVersion is not 1", async () => {
    await expect(resolveExecSecret(execProtocolV2ScriptPath)).rejects.toThrow(
      "protocolVersion must be 1",
    );
  });

  itPosix("rejects exec refs when response omits requested id", async () => {
    await expect(resolveExecSecret(execMissingIdScriptPath)).rejects.toThrow(
      'response missing id "openai/api-key"',
    );
  });

  itPosix("rejects exec refs when missing response id is inherited", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "exec", provider: "execmain", id: "toString" },
        {
          config: {
            secrets: {
              providers: {
                execmain: createExecProviderConfig(execMissingIdScriptPath),
              },
            },
          },
        },
      ),
    ).rejects.toThrow('response missing id "toString"');
  });

  itPosix("ignores inherited exec response errors", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "exec", provider: "execmain", id: "toString" },
        {
          config: {
            secrets: {
              providers: {
                execmain: createExecProviderConfig(execInheritedErrorScriptPath),
              },
            },
          },
        },
      ),
    ).resolves.toBe("resolved");
  });

  itPosix("rejects exec refs with invalid JSON when jsonOnly is true", async () => {
    await expect(resolveExecSecret(execInvalidJsonScriptPath, { jsonOnly: true })).rejects.toThrow(
      "returned invalid JSON",
    );
  });

  itPosix("supports file singleValue mode with id=value", async () => {
    const root = await createCaseDir("file-single-value");
    const filePath = path.join(root, "token.txt");
    await writeSecureFile(filePath, "raw-token-value\n");

    const value = await resolveSecretRefString(
      { source: "file", provider: "rawfile", id: "value" },
      {
        config: {
          secrets: {
            providers: {
              rawfile: createFileProviderConfig(filePath, {
                mode: "singleValue",
              }),
            },
          },
        },
      },
    );
    expect(value).toBe("raw-token-value");
  });

  itPosix("times out file provider reads when timeoutMs elapses", async () => {
    const root = await createCaseDir("file-timeout");
    const filePath = path.join(root, "secrets.json");
    await writeSecureFile(
      filePath,
      JSON.stringify({
        providers: {
          openai: {
            apiKey: "sk-file-value", // pragma: allowlist secret
          },
        },
      }),
    );

    const sampleHandle = await fs.open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(sampleHandle) as {
      readFile: typeof sampleHandle.readFile;
    };
    await sampleHandle.close();
    const readFileSpy = vi
      .spyOn(fileHandlePrototype, "readFile")
      .mockImplementation(() => new Promise<Buffer>(() => {}) as never);

    try {
      await expect(
        resolveSecretRefString(
          { source: "file", provider: "filemain", id: "/providers/openai/apiKey" },
          {
            config: {
              secrets: {
                providers: {
                  filemain: createFileProviderConfig(filePath, {
                    timeoutMs: 5,
                  }),
                },
              },
            },
          },
        ),
      ).rejects.toThrow('File provider "filemain" timed out');
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("rejects misconfigured provider source mismatches", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "exec", provider: "default", id: "abc" },
        {
          config: {
            secrets: {
              providers: {
                default: {
                  source: "env",
                },
              },
            },
          },
        },
      ),
    ).rejects.toThrow('has source "env" but ref requests "exec"');
  });

  it("rejects invalid exec ids before provider resolution", async () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      await expect(
        resolveSecretRefValue(
          { source: "exec", provider: "vault", id },
          {
            config: {},
          },
        ),
      ).rejects.toThrow(/Exec secret reference id must match|Secret reference id is empty/);
    }
  });

  it("rejects invalid env, file, and provider refs before provider resolution", async () => {
    await expect(
      resolveSecretRefValue(
        { source: "env", provider: "default", id: "bad id" },
        {
          config: {},
        },
      ),
    ).rejects.toThrow("Env secret reference id must match");

    await expect(
      resolveSecretRefValue(
        { source: "file", provider: "default", id: "providers/openai/apiKey" },
        {
          config: {},
        },
      ),
    ).rejects.toThrow("File secret reference id must be an absolute JSON pointer");

    await expect(
      resolveSecretRefValue(
        { source: "env", provider: "Default", id: "OPENAI_API_KEY" },
        {
          config: {},
        },
      ),
    ).rejects.toThrow("Secret reference provider must match");
  });

  it("strips UTF-8 BOM from file provider payload before JSON parse", async () => {
    const dir = await createCaseDir("bom-file");
    const filePath = path.join(dir, "secrets-with-bom.json");
    // Write JSON with UTF-8 BOM prefix (EF BB BF)
    const bom = "\uFEFF";
    await writeSecureFile(filePath, `${bom}{"apiKey":"sk-test-123"}`);

    const value = await resolveSecretRefString(
      { source: "file", provider: "filemain", id: "/apiKey" },
      {
        config: {
          secrets: {
            providers: {
              filemain: createFileProviderConfig(filePath),
            },
          },
        },
      },
    );
    expect(value).toBe("sk-test-123");
  });

  it("strips UTF-8 BOM from file provider singleValue mode", async () => {
    const dir = await createCaseDir("bom-single");
    const filePath = path.join(dir, "secret-with-bom.txt");
    const bom = "\uFEFF";
    await writeSecureFile(filePath, `${bom}my-secret-value\n`);

    const value = await resolveSecretRefString(
      { source: "file", provider: "filemain", id: "value" },
      {
        config: {
          secrets: {
            providers: {
              filemain: createFileProviderConfig(filePath, { mode: "singleValue" }),
            },
          },
        },
      },
    );
    expect(value).toBe("my-secret-value");
  });

  it("fails closed on Windows when file provider ACL source is unknown", async () => {
    await withMockedWindowsPlatform(async () => {
      const dir = await createCaseDir("win-acl");
      const filePath = path.join(dir, "secrets.json");
      await writeSecureFile(filePath, '{"token":"abc123"}');

      await expect(
        resolveSecretRefString(
          { source: "file", provider: "filemain", id: "/token" },
          {
            config: {
              secrets: {
                providers: {
                  filemain: createFileProviderConfig(filePath),
                },
              },
            },
          },
        ),
      ).rejects.toThrow(/ACL verification unavailable on Windows/);
    });
  });

  it("allows trusted file provider opt-out when Windows ACL source is unknown", async () => {
    await withMockedWindowsPlatform(async () => {
      const dir = await createCaseDir("win-acl-opt-out");
      const filePath = path.join(dir, "secrets.json");
      await writeSecureFile(filePath, '{"token":"abc123"}');

      const value = await resolveSecretRefString(
        { source: "file", provider: "filemain", id: "/token" },
        {
          config: {
            secrets: {
              providers: {
                filemain: createFileProviderConfig(filePath, { allowInsecurePath: true }),
              },
            },
          },
        },
      );
      expect(value).toBe("abc123");
    });
  });

  it("fails closed on Windows when exec provider ACL source is unknown", async () => {
    await withMockedWindowsPlatform(async () => {
      await expect(resolveExecSecret(execProtocolV1ScriptPath)).rejects.toThrow(
        /ACL verification unavailable on Windows/,
      );
    });
  });
});
