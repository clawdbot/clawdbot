import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMockedWindowsAclVerificationUnavailable } from "../test-utils/vitest-spies.js";
import { assertSecureExecCommandPath } from "./exec-provider-path-validation.js";

describe("exec provider command path validation", () => {
  const isWindows = process.platform === "win32";
  function itPosix(name: string, fn: () => Promise<void> | void) {
    it.skipIf(isWindows)(name, fn);
  }
  let fixtureRoot = "";
  let validExecutablePath = "";
  let executionMarkerPath = "";
  let caseId = 0;
  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir);
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-provider-path-validation-")),
    );
    validExecutablePath = path.join(fixtureRoot, "valid-executable");
    executionMarkerPath = path.join(fixtureRoot, "executed");
    await fs.writeFile(
      validExecutablePath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(executionMarkerPath)}, "executed");\n`,
    );
    await fs.chmod(validExecutablePath, 0o755);
  });
  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts a valid regular executable without executing it", async () => {
    const securePath = await assertSecureExecCommandPath({
      command: validExecutablePath,
      label: "secrets.providers.execmain.command",
    });
    expect(securePath).toBe(validExecutablePath);
    await expect(fs.access(executionMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("rejects missing command paths", async () => {
    const root = await createCaseDir("missing");
    await expect(
      assertSecureExecCommandPath({
        command: path.join(root, "no-such-binary"),
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("is not readable");
  });

  itPosix("rejects directory command paths", async () => {
    const root = await createCaseDir("dir");
    await expect(
      assertSecureExecCommandPath({
        command: root,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must be a file");
  });

  itPosix("rejects symlinked command paths", async () => {
    const root = await createCaseDir("link");
    const symlinkPath = path.join(root, "exec-link");
    await fs.symlink(validExecutablePath, symlinkPath);
    await expect(
      assertSecureExecCommandPath({
        command: symlinkPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  itPosix("rejects world-writable command paths", async () => {
    const root = await createCaseDir("writable");
    const scriptPath = path.join(root, "helper");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(scriptPath, 0o666);
    await expect(
      assertSecureExecCommandPath({
        command: scriptPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("permissions are too open");
  });

  itPosix("accepts regular files lacking the owner-execute bit (startup parity)", async () => {
    const root = await createCaseDir("non-exec");
    const scriptPath = path.join(root, "not-executable");
    await fs.writeFile(scriptPath, "not executable\n");
    await fs.chmod(scriptPath, 0o600);
    await expect(
      assertSecureExecCommandPath({
        command: scriptPath,
        label: "secrets.providers.execmain.command",
      }),
    ).resolves.toBe(scriptPath);
  });

  itPosix("rejects commands outside trustedDirs", async () => {
    const root = await createCaseDir("trusted");
    const trustedDir = path.join(root, "trusted");
    await fs.mkdir(trustedDir);
    await expect(
      assertSecureExecCommandPath({
        command: validExecutablePath,
        label: "secrets.providers.execmain.command",
        trustedDirs: [trustedDir],
      }),
    ).rejects.toThrow("is outside trustedDirs");
  });

  itPosix("accepts a regular command inside trustedDirs", async () => {
    const root = await createCaseDir("trusted-ok");
    const trustedDir = path.join(root, "trusted");
    await fs.mkdir(trustedDir, { recursive: true });
    const copy = path.join(trustedDir, "helper");
    await fs.writeFile(copy, "#!/bin/sh\nexit 1\n");
    await fs.chmod(copy, 0o755);
    await expect(
      assertSecureExecCommandPath({
        command: copy,
        label: "secrets.providers.execmain.command",
        trustedDirs: [trustedDir],
      }),
    ).resolves.toBe(copy);
  });

  it("fails closed with a supported recovery message when Windows ACL verification is unavailable", async () => {
    await withMockedWindowsAclVerificationUnavailable(
      path.join(fixtureRoot, "missing-windows-system-root"),
      async () => {
        await expect(
          assertSecureExecCommandPath({
            command: validExecutablePath,
            label: "secrets.providers.execmain.command",
          }),
        ).rejects.toMatchObject({
          code: "permission-unverified",
          message: expect.stringMatching(
            /ACL verification unavailable on Windows.*no provider-level bypass/,
          ),
        });
      },
    );
  });
});
