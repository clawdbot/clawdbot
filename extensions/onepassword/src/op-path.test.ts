import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrustedExecutablePath, testing } from "../onepassword-op-path.js";
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

describe("1Password CLI owner trust", () => {
  it("copies the Node fixture without mutating the installed runtime", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-op-path-"));
    const before = await fs.stat(process.execPath);
    try {
      const fixture = createTrustedNodeFixture(tempDir);
      const [sourceAfter, fixtureStat] = await Promise.all([
        fs.stat(process.execPath),
        fs.stat(fixture),
      ]);
      expect(sourceAfter.mode).toBe(before.mode);
      expect([fixtureStat.dev, fixtureStat.ino]).not.toEqual([sourceAfter.dev, sourceAfter.ino]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires generic executable paths to be absolute", async () => {
    await expect(resolveTrustedExecutablePath("taskkill.exe")).rejects.toThrow(
      "Executable path must be absolute",
    );
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes an intentional executable symlink before trust validation",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-op-path-"));
      const executable = path.join(tempDir, "op-real");
      const symlink = path.join(tempDir, "op");
      try {
        const interpreter = createTrustedNodeFixture(tempDir);
        await fs.writeFile(executable, `#!${interpreter}\nprocess.exit(0);\n`, {
          mode: 0o700,
        });
        await fs.symlink(executable, symlink);
        await expect(resolveTrustedExecutablePath(symlink)).resolves.toBe(
          await fs.realpath(executable),
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("rejects env-indirected script interpreters", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-op-path-"));
    const executable = path.join(tempDir, "op");
    try {
      await fs.writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
      await expect(resolveTrustedExecutablePath(executable)).rejects.toThrow(/env indirection/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects non-canonical script interpreter aliases",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-op-path-"));
      const executable = path.join(tempDir, "op");
      try {
        const canonicalInterpreter = createTrustedNodeFixture(tempDir);
        const alias = path.join(tempDir, "node-alias");
        await fs.symlink(canonicalInterpreter, alias);
        await fs.writeFile(executable, `#!${alias}\nprocess.exit(0);\n`, { mode: 0o700 });
        await expect(resolveTrustedExecutablePath(executable)).rejects.toThrow(/must be canonical/);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("requires verified Windows ownership", () => {
    expect(testing.isTrustedOwner({}, { ownerTrusted: true }, "win32")).toBe(true);
    expect(testing.isTrustedOwner({}, { ownerTrusted: false }, "win32")).toBe(false);
    expect(testing.isTrustedOwner({}, {}, "win32")).toBe(false);
  });

  it("accepts the well-known Windows TrustedInstaller owner", () => {
    expect(
      testing.isTrustedOwner(
        {},
        {
          ownerTrusted: false,
          ownerSid: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        },
        "win32",
        true,
      ),
    ).toBe(true);
    expect(
      testing.isTrustedOwner(
        {},
        {
          ownerTrusted: false,
          ownerSid: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        },
        "win32",
      ),
    ).toBe(false);
  });

  it("accepts only additive, read-only, or inherit-only untrusted directory rights", () => {
    expect(
      testing.isSafeWindowsDirectoryAclEntries([
        { rawRights: "(OI)(CI)(RX)" },
        { rawRights: "(CI)(AD)" },
        { rawRights: "(CI)(IO)(WD)" },
        { rawRights: "(OI)(CI)(IO)(F)" },
      ]),
    ).toBe(true);
    expect(
      testing.isSafeWindowsDirectoryAclEntries([
        { rawRights: "(I)(CI)(WD,AD)" },
        { rawRights: "(I)(GR,GE)" },
      ]),
    ).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([])).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(M)" }])).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "unknown" }])).toBe(false);
  });

  it("rejects child creation rights beside the executable", () => {
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(RX)" }], false)).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(AD)" }], false)).toBe(
      false,
    );
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(WD)" }], false)).toBe(
      false,
    );
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(IO)(WD)" }], false)).toBe(
      true,
    );
  });

  it("uses the verified fs-safe ACL summary for Windows directory rights", () => {
    expect(testing.isSafeWindowsDirectoryAclSummary("trusted-only")).toBe(true);
    expect(
      testing.isSafeWindowsDirectoryAclSummary(
        "BUILTIN\\Users:(RX), CREATOR OWNER:(OI)(CI)(IO)(F)",
      ),
    ).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclSummary("BUILTIN\\Users:(M)")).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclSummary("BUILTIN\\Users:unknown")).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclSummary(undefined)).toBe(false);
  });

  it.runIf(typeof process.getuid === "function")(
    "accepts only the current POSIX uid or root",
    () => {
      const uid = process.getuid?.() ?? 1;
      expect(testing.isTrustedOwner({ uid }, {}, "linux")).toBe(true);
      expect(testing.isTrustedOwner({ uid: 0 }, {}, "linux")).toBe(true);
      expect(testing.isTrustedOwner({ uid: uid + 1 }, {}, "linux")).toBe(false);
    },
  );
});
