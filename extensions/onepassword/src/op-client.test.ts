import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePasswordError } from "./errors.js";
import { OpClient } from "./op-client.js";

type OpProcessRunner = NonNullable<ConstructorParameters<typeof OpClient>[0]["runner"]>;

const tempDirs: string[] = [];

describe("OpClient", () => {
  let root = "";
  let opBin = "";
  let tokenFile = "";
  const fixtureAuth = ["fixture", "auth"].join("-");
  const rightFixture = ["right", "fixture"].join("-");

  beforeEach(async () => {
    // openclaw-temp-dir: allow plugin tests cannot import the core-only tracker.
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-"));
    tempDirs.push(root);
    opBin = path.join(root, "op");
    tokenFile = path.join(root, "service-account-token");
    await fs.writeFile(opBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.writeFile(tokenFile, `  ${fixtureAuth}\n`, { mode: 0o600 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
    );
  });

  it("constructs one cache-disabled request with minimal environment and trims the token", async () => {
    const runner = vi.fn<OpProcessRunner>(async () => ({
      stdout: JSON.stringify({
        id: "new",
        label: "credential",
        value: rightFixture,
      }),
      stderr: "",
    }));
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1234, runner, home: root });

    await expect(
      client.getItem({ item: "Repository token", vault: "Automation", field: "credential" }),
    ).resolves.toEqual({
      value: rightFixture,
      itemTitle: "Repository token",
      fieldLabel: "credential",
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      opBin,
      [
        "item",
        "get",
        "Repository token",
        "--vault",
        "Automation",
        "--fields",
        "credential",
        "--format",
        "json",
        "--cache=false",
      ],
      {
        env: {
          OP_SERVICE_ACCOUNT_TOKEN: fixtureAuth,
          HOME: root,
          OP_LOAD_DESKTOP_APP_SETTINGS: "false",
          OP_BIOMETRIC_UNLOCK_ENABLED: "false",
        },
        timeoutMs: 1234,
        maxBufferBytes: 1024 * 1024,
      },
    );
  });

  it("accepts a response selected by field id", async () => {
    const runner: OpProcessRunner = async () => ({
      stdout: JSON.stringify({ id: "credential", label: "password", value: "by-id" }),
      stderr: "",
    });
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });
    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).resolves.toMatchObject({ value: "by-id", fieldLabel: "password" });
  });

  it("rejects a mismatched field response without exposing its value", async () => {
    const runner: OpProcessRunner = async () => ({
      stdout: JSON.stringify({
        id: "one",
        label: "username",
        value: ["private", "user"].join("-"),
      }),
      stderr: "",
    });
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });
    const error = await client
      .getItem({ item: "Token", vault: "Automation", field: "credential" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OnePasswordError);
    expect(error).toMatchObject({ code: "FIELD_NOT_FOUND" });
    expect(String(error)).not.toContain("private-");
  });

  it("surfaces missing and empty token files as TOKEN_MISSING", async () => {
    await fs.rm(tokenFile);
    const runner = vi.fn<OpProcessRunner>();
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });
    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).rejects.toMatchObject({ code: "TOKEN_MISSING" });
    expect(runner).not.toHaveBeenCalled();

    await fs.writeFile(tokenFile, " \n", { mode: 0o600 });
    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).rejects.toMatchObject({ code: "TOKEN_MISSING" });
  });

  it("rejects oversized token files before invoking the 1Password CLI", async () => {
    await fs.writeFile(tokenFile, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    const runner = vi.fn<OpProcessRunner>();
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });

    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).rejects.toMatchObject({
      code: "TOKEN_MISSING",
      message: `1Password service account token file at ${tokenFile} exceeds 16384 bytes.`,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "continues to accept a token file through a %s",
    async (linkType) => {
      const targetFile = path.join(root, "service-account-token-target");
      await fs.rename(tokenFile, targetFile);
      if (linkType === "symlink") {
        await fs.symlink(targetFile, tokenFile);
      } else {
        await fs.link(targetFile, tokenFile);
      }
      const runner = vi.fn<OpProcessRunner>(async () => ({
        stdout: JSON.stringify({ label: "credential", value: "value" }),
        stderr: "",
      }));
      const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });

      await expect(
        client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
      ).resolves.toMatchObject({ value: "value" });
      expect(runner).toHaveBeenCalledWith(
        opBin,
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ OP_SERVICE_ACCOUNT_TOKEN: fixtureAuth }),
        }),
      );
    },
  );

  it("warns once for token file permissions broader than 0600", async () => {
    await fs.chmod(tokenFile, 0o644);
    const warn = vi.fn();
    const runner: OpProcessRunner = async () => ({
      stdout: JSON.stringify({ label: "credential", value: "value" }),
      stderr: "",
    });
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner, warn });
    await client.getItem({ item: "Token", vault: "Automation", field: "credential" });
    await client.getItem({ item: "Token", vault: "Automation", field: "credential" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["RATE_LIMITED", { stderr: "request failed: 429 rate limit", code: 1 }],
    ["ITEM_NOT_FOUND", { stderr: "item is not found", code: 1 }],
    ["ITEM_NOT_FOUND", { stderr: `"Token" isn't an item in the "Automation" vault`, code: 1 }],
    [
      "ITEM_NOT_FOUND",
      { stderr: `"Rate limit token" isn't an item in the "Automation" vault`, code: 1 },
    ],
    ["FIELD_NOT_FOUND", { stderr: `"credential" isn't a field in the "Token" item`, code: 1 }],
    ["FIELD_NOT_FOUND", { stderr: `"429 credential" isn't a field in the "Token" item`, code: 1 }],
    ["AUTH_FAILED", { stderr: "unauthorized service account", code: 1 }],
    ["TIMEOUT", { stderr: "", killed: true, signal: "SIGTERM" }],
    ["TIMEOUT", { stderr: "", timedOut: true }],
    ["OP_ERROR", { stderr: "unexpected failure", code: 1 }],
  ] as const)("maps process failure to %s without retry", async (expectedCode, failure) => {
    const runner = vi.fn<OpProcessRunner>(async () => {
      throw Object.assign(new Error("op failed"), failure);
    });
    const client = new OpClient({ opBin, tokenFile, timeoutMs: 1000, runner });
    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).rejects.toMatchObject({ code: expectedCode });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("reports an unresolved binary without invoking a runner", async () => {
    const runner = vi.fn<OpProcessRunner>();
    const client = new OpClient({
      opBin: path.join(root, "missing-op"),
      tokenFile,
      timeoutMs: 1000,
      runner,
    });
    await expect(
      client.getItem({ item: "Token", vault: "Automation", field: "credential" }),
    ).rejects.toMatchObject({ code: "OP_NOT_FOUND" });
    expect(runner).not.toHaveBeenCalled();
  });
});
