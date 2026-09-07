import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";
import { resolveCliExecutableIdentity } from "./cli-executable-identity.js";

const tempDirs: string[] = [];

function makePackage(): { root: string; entrypoint: string; implementation: string } {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-artifact-")),
  );
  tempDirs.push(root);
  const entrypoint = path.join(root, "bin", "cli.js");
  const implementation = path.join(root, "dist", "main.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(implementation), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@fixture/verified-cli", version: "1.0.0" })}\n`,
  );
  fs.writeFileSync(entrypoint, `#!${process.execPath}\nimport "../dist/main.js";\n`, {
    mode: 0o755,
  });
  fs.chmodSync(entrypoint, 0o755);
  fs.writeFileSync(implementation, 'export const revision = "first";\n');
  return { root, entrypoint, implementation };
}

const commandPackagePolicy: CliBackendRuntimeArtifactPolicy = {
  kind: "bundled-package-tree",
  packageName: "@fixture/verified-cli",
  entrypoint: "command",
};

describe("CLI executable implementation identity", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes when package implementation changes behind an unchanged launcher", async () => {
    const fixture = makePackage();
    const first = await resolveCliExecutableIdentity({
      command: fixture.entrypoint,
      runtimeArtifact: commandPackagePolicy,
    });
    fs.writeFileSync(fixture.implementation, 'export const revision = "replacement";\n');
    const second = await resolveCliExecutableIdentity({
      command: fixture.entrypoint,
      runtimeArtifact: commandPackagePolicy,
    });

    expect(first?.runtimeArtifact.kind).toBe("package-tree");
    expect(first?.runtimeArtifact).toMatchObject({ packageVersion: "1.0.0" });
    expect(second?.runtimeArtifact.kind).toBe("package-tree");
    expect(second?.runtimeArtifact).not.toEqual(first?.runtimeArtifact);
    const firstEntrypoint = first?.files.find((file) => file.path === fixture.entrypoint);
    expect(firstEntrypoint).toBeDefined();
    expect(second?.files.find((file) => file.path === fixture.entrypoint)).toEqual(firstEntrypoint);
  });

  it.runIf(process.platform === "win32")(
    "rejects mixed-case relative PATH entries and accepts mixed-case absolute entries",
    async () => {
      // Keep the PATH fixture on cwd's drive, outside concurrent compiler input scans.
      const artifactRoot = path.join(process.cwd(), ".artifacts");
      fs.mkdirSync(artifactRoot, { recursive: true });
      const root = fs.realpathSync.native(
        makeTempDir(tempDirs, "openclaw-cli-path-case-", artifactRoot),
      );
      const binDir = path.join(root, "bin");
      const executable = path.join(binDir, "mixed-identity.exe");
      fs.mkdirSync(binDir);
      fs.copyFileSync(process.execPath, executable);
      const relativeBinDir = path.relative(process.cwd(), binDir);
      const runtimeArtifact: CliBackendRuntimeArtifactPolicy = {
        ...commandPackagePolicy,
        nativeExecutableNames: ["mixed-identity.exe"],
      };

      expect(path.isAbsolute(relativeBinDir)).toBe(false);
      await expect(
        resolveCliExecutableIdentity({
          command: "mixed-identity",
          env: { pAtH: relativeBinDir, pAtHeXt: ".EXE" },
          runtimeArtifact,
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolveCliExecutableIdentity({
          command: ".\\mixed-identity.exe",
          cwd: binDir,
          env: { pAtH: binDir, pAtHeXt: ".EXE" },
          runtimeArtifact,
        }),
      ).resolves.toBeUndefined();

      for (const command of [executable, "~/mixed-identity.exe", "~\\mixed-identity.exe"]) {
        const absoluteIdentity = await resolveCliExecutableIdentity({
          command,
          env: { HOME: binDir, pAtH: binDir, pAtHeXt: ".CMD" },
          runtimeArtifact,
        });
        expect(absoluteIdentity?.resolvedPath).toBe(fs.realpathSync.native(executable));
      }

      const identity = await resolveCliExecutableIdentity({
        command: "mixed-identity",
        env: { pAtH: binDir, pAtHeXt: ".EXE" },
        runtimeArtifact,
      });
      expect(identity?.resolvedPath).toBe(fs.realpathSync.native(executable));
      expect(identity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });
    },
  );

  describe.runIf(process.platform === "win32")("Windows npm shim identity", () => {
    it.each([
      { artifact: "native", command: "explicit" },
      { artifact: "native", command: "bare" },
      { artifact: "package", command: "explicit" },
      { artifact: "package", command: "bare" },
    ] as const)("executes the bound $artifact owner for a $command command", async (scenario) => {
      const fixture = makePackage();
      const wrapperDir = path.join(fixture.root, "wrappers");
      fs.mkdirSync(wrapperDir);
      const entrypoint =
        scenario.artifact === "native"
          ? path.join(fixture.root, "bin", "verified-cli.exe")
          : fixture.entrypoint;
      if (scenario.artifact === "native") {
        fs.copyFileSync(process.execPath, entrypoint);
      } else {
        const hookRoot = fs.realpathSync.native(
          fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-unbound-hook-")),
        );
        tempDirs.push(hookRoot);
        const hook = path.join(hookRoot, "unbound-hook.cjs");
        fs.writeFileSync(hook, 'throw new Error("unbound-hook-loaded");\n');
        // Windows invokes Node with the script path, so shebang flags must remain inert.
        fs.writeFileSync(
          entrypoint,
          `#!${process.execPath} --require=${hook}\nimport "../dist/main.js";\n`,
        );
        fs.writeFileSync(fixture.implementation, 'process.stdout.write("identity-ok");\n');
      }
      const posixShim = path.join(wrapperDir, "verified-cli");
      const cmdShim = `${posixShim}.cmd`;
      const relativeEntrypoint = path.relative(wrapperDir, entrypoint);
      fs.writeFileSync(
        posixShim,
        `#!/bin/sh\nexec "$basedir/${relativeEntrypoint.replaceAll("\\", "/")}" "$@"\n`,
      );
      fs.writeFileSync(cmdShim, `@ECHO off\r\n"%~dp0\\${relativeEntrypoint}" %*\r\n`);
      const env = {
        pAtH: `${wrapperDir};${path.dirname(process.execPath)}`,
        pAtHeXt: ".CMD;.EXE",
      };
      const identity = await resolveCliExecutableIdentity({
        command: scenario.command === "bare" ? "verified-cli" : cmdShim,
        env,
        runtimeArtifact: {
          ...commandPackagePolicy,
          nativeExecutableNames: ["verified-cli.exe"],
        },
      });

      assert.ok(identity, "The Windows command must bind to its executable owner.");
      expect(identity.resolvedPath).toBe(cmdShim);
      expect(identity.invocation).toEqual({
        command:
          scenario.artifact === "native" ? entrypoint : fs.realpathSync.native(process.execPath),
        leadingArgv: scenario.artifact === "native" ? [] : [entrypoint],
        resolution: scenario.artifact === "native" ? "exe-entrypoint" : "node-entrypoint",
      });
      expect(identity.runtimeArtifact.kind).toBe(
        scenario.artifact === "native" ? "self-contained-executable" : "package-tree",
      );
      expect(identity.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([cmdShim, entrypoint]),
      );
      expect(identity.files.some((file) => file.path === posixShim)).toBe(false);
      const args =
        scenario.artifact === "native" ? ["-e", 'process.stdout.write("identity-ok")'] : [];
      const child = spawnSync(
        identity.invocation.command,
        [...identity.invocation.leadingArgv, ...args],
        {
          env,
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("identity-ok");
    });

    it("does not bind a missing PATH command to an executable in the current directory", async () => {
      const fixture = makePackage();
      const emptyPath = path.join(fixture.root, "empty-path");
      const command = `openclaw-cli-missing-owner-${randomUUID()}.exe`;
      const executable = path.join(process.cwd(), command);
      fs.mkdirSync(emptyPath);
      // Workers cannot chdir; this uniquely owned file exercises implicit cwd lookup.
      fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_EXCL);
      try {
        await expect(
          resolveCliExecutableIdentity({
            command,
            env: { PATH: emptyPath, PATHEXT: ".EXE" },
            runtimeArtifact: {
              ...commandPackagePolicy,
              nativeExecutableNames: [command],
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        fs.rmSync(executable);
      }
    });

    it("keeps explicitly selected POSIX shims and arbitrary batch wrappers unverified", async () => {
      const fixture = makePackage();
      const posixShim = path.join(fixture.root, "unsafe-cli");
      const cmdShim = `${posixShim}.cmd`;
      fs.writeFileSync(posixShim, '#!/bin/sh\nexec "$basedir/bin/cli.js" "$@"\n');
      fs.writeFileSync(cmdShim, '@ECHO off\r\nSET WRAPPER_FLAG=1\r\n"%~dp0\\bin\\cli.js" %*\r\n');
      for (const command of [posixShim, cmdShim, "unsafe-cli"]) {
        await expect(
          resolveCliExecutableIdentity({
            command,
            env: { PATH: fixture.root, PATHEXT: ".CMD;.EXE" },
            runtimeArtifact: commandPackagePolicy,
          }),
        ).resolves.toBeUndefined();
      }
    });
  });

  it("does not depend on host locale collation when ordering package files", async () => {
    const fixture = makePackage();
    fs.writeFileSync(path.join(fixture.root, "dist", "z.js"), "z\n");
    fs.writeFileSync(path.join(fixture.root, "dist", "ä.js"), "a-umlaut\n");
    let identity: Awaited<ReturnType<typeof resolveCliExecutableIdentity>>;
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale collation must not participate in artifact identity");
    });
    try {
      identity = await resolveCliExecutableIdentity({
        command: fixture.entrypoint,
        runtimeArtifact: commandPackagePolicy,
      });
    } finally {
      localeCompare.mockRestore();
    }

    expect(identity?.runtimeArtifact.kind).toBe("package-tree");
  });

  it("rejects an unknown script or a package policy with the wrong owner", async () => {
    const fixture = makePackage();
    await expect(
      resolveCliExecutableIdentity({ command: fixture.entrypoint }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCliExecutableIdentity({
        command: fixture.entrypoint,
        runtimeArtifact: { ...commandPackagePolicy, packageName: "@fixture/other" },
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["dependencies", "peerDependencies"] as const)(
    "rejects required %s that may resolve outside the package tree",
    async (field) => {
      const fixture = makePackage();
      fs.writeFileSync(
        path.join(fixture.root, "package.json"),
        `${JSON.stringify({
          name: "@fixture/verified-cli",
          version: "1.0.0",
          [field]: { "@fixture/external-runtime": "1.0.0" },
        })}\n`,
      );

      await expect(
        resolveCliExecutableIdentity({
          command: fixture.entrypoint,
          runtimeArtifact: commandPackagePolicy,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("rejects an interpreter launcher whose command is outside the package", async () => {
    await expect(
      resolveCliExecutableIdentity({
        command: process.execPath,
        runtimeArtifact: commandPackagePolicy,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires a positive native executable name under a backend package policy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-native-policy-"));
    tempDirs.push(root);
    const executable = path.join(root, "claude");
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);

    await expect(resolveCliExecutableIdentity({ command: executable })).resolves.toBeUndefined();
    await expect(
      resolveCliExecutableIdentity({
        command: executable,
        runtimeArtifact: commandPackagePolicy,
      }),
    ).resolves.toBeUndefined();
    const identity = await resolveCliExecutableIdentity({
      command: executable,
      runtimeArtifact: {
        ...commandPackagePolicy,
        nativeExecutableNames: ["claude"],
      },
    });
    expect(identity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });

    if (process.platform !== "win32") {
      const unlistedExecutable = path.join(root, "other-cli");
      fs.copyFileSync(process.execPath, unlistedExecutable);
      fs.chmodSync(unlistedExecutable, 0o755);
      await expect(
        resolveCliExecutableIdentity({
          command: unlistedExecutable,
          runtimeArtifact: {
            ...commandPackagePolicy,
            nativeExecutableNames: ["claude"],
          },
        }),
      ).resolves.toBeUndefined();

      const versionedExecutable = path.join(root, "2.1.205");
      const commandLink = path.join(root, "claude-link");
      fs.copyFileSync(process.execPath, versionedExecutable);
      fs.chmodSync(versionedExecutable, 0o755);
      fs.symlinkSync(versionedExecutable, commandLink);
      const linkedIdentity = await resolveCliExecutableIdentity({
        command: commandLink,
        runtimeArtifact: {
          ...commandPackagePolicy,
          nativeExecutableNames: ["claude-link"],
        },
      });
      expect(linkedIdentity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });
      expect(linkedIdentity?.resolvedPath).toBe(fs.realpathSync.native(versionedExecutable));
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects POSIX package script shebang flags that can load external code",
    async () => {
      const fixture = makePackage();
      fs.writeFileSync(
        fixture.entrypoint,
        `#!${process.execPath} --require=/tmp/unbound-hook.cjs\nimport "../dist/main.js";\n`,
        { mode: 0o755 },
      );

      await expect(
        resolveCliExecutableIdentity({
          command: fixture.entrypoint,
          runtimeArtifact: commandPackagePolicy,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("binds nested package dependencies and rejects redirecting symlinks", async () => {
    const nested = makePackage();
    fs.mkdirSync(path.join(nested.root, "node_modules", "dependency"), { recursive: true });
    const dependency = path.join(nested.root, "node_modules", "dependency", "index.js");
    fs.writeFileSync(dependency, "first\n");
    const first = await resolveCliExecutableIdentity({
      command: nested.entrypoint,
      runtimeArtifact: commandPackagePolicy,
    });
    fs.writeFileSync(dependency, "replacement\n");
    const second = await resolveCliExecutableIdentity({
      command: nested.entrypoint,
      runtimeArtifact: commandPackagePolicy,
    });
    expect(first?.runtimeArtifact.kind).toBe("package-tree");
    expect(second?.runtimeArtifact).not.toEqual(first?.runtimeArtifact);

    if (process.platform !== "win32") {
      const symlinked = makePackage();
      fs.symlinkSync(symlinked.implementation, path.join(symlinked.root, "dist", "redirect.js"));
      await expect(
        resolveCliExecutableIdentity({
          command: symlinked.entrypoint,
          runtimeArtifact: commandPackagePolicy,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects an oversized sparse package file before reading its contents", async () => {
    const fixture = makePackage();
    const oversized = path.join(fixture.root, "dist", "oversized.bin");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 1024 * 1024 * 1024 + 1);

    await expect(
      resolveCliExecutableIdentity({
        command: fixture.entrypoint,
        runtimeArtifact: commandPackagePolicy,
      }),
    ).resolves.toBeUndefined();
  });
});
