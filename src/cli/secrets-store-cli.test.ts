import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecretsCli } from "./secrets-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    updateHosts: vi.fn(),
    remove: vi.fn(),
    purge: vi.fn(),
    gatewayIdentity: vi.fn(),
    confirm: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  // Import the real validation error: the CLI classifies size/empty failures by it,
  // and a stub class would silently change the mapped exit code.
  SecretStoreValidationError: (
    await importOriginal<typeof import("../secrets/store/secret-store.js")>()
  ).SecretStoreValidationError,
  normalizeSecretAllowedHosts: (
    await importOriginal<typeof import("../secrets/store/secret-store.js")>()
  ).normalizeSecretAllowedHosts,
  SECRET_STORE_VALUE_MAX_BYTES: 64 * 1024,
  listSecretStoreEntries: (params: unknown) => mocks.list(params),
  readSecretStoreValue: (params: unknown) => mocks.read(params),
  writeSecretStoreEntry: (params: unknown) => mocks.write(params),
  updateSecretStoreAllowedHosts: (params: unknown) => mocks.updateHosts(params),
  deleteSecretStoreEntry: (params: unknown) => mocks.remove(params),
  purgeExpiredSecretStoreEntries: () => mocks.purge(),
}));
vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => mocks.gatewayIdentity(),
}));
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    confirm: (options: unknown) => mocks.confirm(options),
    isCancel: (value: unknown) => typeof value === "symbol",
  };
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerSecretsCli(program);
  return program;
}

beforeEach(() => {
  mocks.runtimeLogs.length = 0;
  mocks.runtimeErrors.length = 0;
  mocks.list.mockReset().mockReturnValue([]);
  mocks.read.mockReset();
  mocks.write.mockReset();
  mocks.updateHosts.mockReset();
  mocks.remove.mockReset();
  mocks.purge.mockReset();
  mocks.gatewayIdentity.mockReset().mockResolvedValue(undefined);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.defaultRuntime.log.mockClear();
  mocks.defaultRuntime.error.mockClear();
  mocks.defaultRuntime.writeStdout.mockClear();
  mocks.defaultRuntime.writeJson.mockClear();
  mocks.defaultRuntime.exit.mockClear();
});

describe("secrets store CLI", () => {
  it("shows non-secret allowed-host metadata in list output", async () => {
    mocks.list.mockReturnValue([
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.com", "uploads.example.com"],
      },
    ]);

    await createProgram().parseAsync(["secrets", "store", "list"], { from: "user" });

    expect(mocks.runtimeLogs.join("\n")).toContain(
      "allowed hosts: api.example.com, uploads.example.com",
    );
  });

  it("refuses --value for secret entries with all safe alternatives and exit 2", async () => {
    await expect(
      createProgram().parseAsync(
        ["secrets", "store", "set", "SERVICE_API_KEY", "--kind", "secret", "--value", "leaked"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:2");

    expect(mocks.runtimeErrors.join("\n")).toContain("stdin pipe");
    expect(mocks.runtimeErrors.join("\n")).toContain("--value-file");
    expect(mocks.runtimeErrors.join("\n")).toContain("interactive no-echo prompt");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("reports an oversized --value-file as validation (exit 2), matching the stdin path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secret-store-cli-oversize-"));
    const file = path.join(dir, "too-big.txt");
    await fs.writeFile(file, "a".repeat(64 * 1024 + 1), "utf8");
    try {
      // Same violation as an oversized stdin value, so it must share exit code 2
      // rather than falling through to the generic runtime-failure code.
      await expect(
        createProgram().parseAsync(
          ["secrets", "store", "set", "BIG_ENV_VALUE", "--kind", "env", "--value-file", file],
          { from: "user" },
        ),
      ).rejects.toThrow("__exit__:2");
      expect(mocks.write).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses get for secret entries without reading their values", async () => {
    mocks.list.mockReturnValue([{ name: "SERVICE_API_KEY", kind: "secret" }]);
    await expect(
      createProgram().parseAsync(["secrets", "store", "get", "SERVICE_API_KEY"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:2");

    expect(mocks.runtimeErrors.join("\n")).toContain("write-only by design");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("normalizes repeatable allowed hosts and can clear them without replacing the secret", async () => {
    mocks.list.mockReturnValue([{ name: "MISC_VALUE", kind: "secret" }]);

    await createProgram().parseAsync(
      [
        "secrets",
        "store",
        "set",
        "MISC_VALUE",
        "--allow-host",
        "API.EXAMPLE.COM",
        "--allow-host",
        "bücher.example",
      ],
      { from: "user" },
    );
    await createProgram().parseAsync(
      ["secrets", "store", "set", "MISC_VALUE", "--clear-allowed-hosts"],
      { from: "user" },
    );

    expect(mocks.updateHosts).toHaveBeenNthCalledWith(1, {
      scope: { kind: "team" },
      name: "MISC_VALUE",
      allowedHosts: ["api.example.com", "xn--bcher-kva.example"],
      updatedBy: "cli",
    });
    expect(mocks.updateHosts).toHaveBeenNthCalledWith(2, {
      scope: { kind: "team" },
      name: "MISC_VALUE",
      allowedHosts: [],
      updatedBy: "cli",
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects wildcard allowed hosts before reading or writing a value", async () => {
    await expect(
      createProgram().parseAsync(
        ["secrets", "store", "set", "SERVICE_API_KEY", "--allow-host", "*.example.com"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:2");

    expect(mocks.runtimeErrors.join("\n")).toContain("cannot contain a wildcard");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.updateHosts).not.toHaveBeenCalled();
  });

  it("returns exit 3 for a missing get and exit 1 for a database failure", async () => {
    mocks.list.mockReturnValueOnce([]);
    await expect(
      createProgram().parseAsync(["secrets", "store", "get", "MISSING_VALUE"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:3");

    mocks.list.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    await expect(
      createProgram().parseAsync(["secrets", "store", "list"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
  });

  it("keeps rm idempotent when entries are already missing", async () => {
    await createProgram().parseAsync(["secrets", "store", "rm", "MISSING_VALUE", "--yes"], {
      from: "user",
    });
    await createProgram().parseAsync(["secrets", "store", "rm", "MISSING_VALUE", "--yes"], {
      from: "user",
    });

    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.runtimeErrors).toEqual([]);
  });

  it("imports quoted and multiline dotenv values without exposing them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-import-"));
    const dotenvPath = path.join(root, "values.env");
    await fs.writeFile(
      dotenvPath,
      [
        'SERVICE_URL="https://service.test/path with spaces"',
        'SERVICE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
        "multiline-body",
        '-----END PRIVATE KEY-----"',
      ].join("\n"),
      "utf8",
    );
    try {
      await createProgram().parseAsync(
        ["secrets", "store", "import", "--from", dotenvPath, "--yes"],
        { from: "user" },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }

    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write.mock.calls[0]?.[0]).toMatchObject({
      name: "SERVICE_URL",
      value: "https://service.test/path with spaces",
      kind: "env",
    });
    expect(mocks.write.mock.calls[1]?.[0]).toMatchObject({
      name: "SERVICE_PRIVATE_KEY",
      value: "-----BEGIN PRIVATE KEY-----\nmultiline-body\n-----END PRIVATE KEY-----",
      kind: "secret",
    });
    const output = [...mocks.runtimeLogs, ...mocks.runtimeErrors].join("\n");
    expect(output).not.toContain("multiline-body");
  });
});
