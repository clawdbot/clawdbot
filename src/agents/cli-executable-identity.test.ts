import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";
import { resolveCliExecutableIdentity } from "./cli-executable-identity.js";

const tempDirs: string[] = [];

function makePackage(): { root: string; entrypoint: string; implementation: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-artifact-"));
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
    expect(second?.runtimeArtifact.kind).toBe("package-tree");
    expect(second?.runtimeArtifact).not.toEqual(first?.runtimeArtifact);
    expect(second?.files.find((file) => file.path === fixture.entrypoint)).toEqual(
      first?.files.find((file) => file.path === fixture.entrypoint),
    );
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
      const mixedCaseExecutable = path.join(root, "CLAUDE");
      fs.copyFileSync(process.execPath, mixedCaseExecutable);
      fs.chmodSync(mixedCaseExecutable, 0o755);
      await expect(
        resolveCliExecutableIdentity({
          command: mixedCaseExecutable,
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
      expect(linkedIdentity?.resolvedPath).toBe(fs.realpathSync(versionedExecutable));
    }
  });

  it("rejects package script shebang flags that can load external code", async () => {
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
  });

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
