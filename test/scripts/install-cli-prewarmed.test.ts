import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "darwin")(
  "installs a prewarmed runtime without downloading or building",
  () => {
    const root = tempDirs.make("openclaw-prewarmed-installer-");
    const archiveRoot = path.join(root, "archive-root");
    const runtimeDirectory = "node-v24.15.0";
    const runtimeRoot = path.join(archiveRoot, "tools", runtimeDirectory);
    const nodePath = path.join(runtimeRoot, "bin", "node");
    const entryPath = path.join(runtimeRoot, "lib", "node_modules", "openclaw", "dist", "entry.js");
    const commit = "a".repeat(40);
    const archivePath = path.join(root, "prewarmed-runtime-arm64.tar.gz");
    const manifestPath = path.join(root, "prewarmed-runtime.json");
    const pluginCacheDir = path.join(root, "prewarmed-plugin-cache");
    const prefix = path.join(root, "prefix");
    const home = path.join(root, "home");

    mkdirSync(path.dirname(nodePath), { recursive: true });
    mkdirSync(path.dirname(entryPath), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      nodePath,
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo v24.15.0; elif [[ "\${1:-}" == *prewarmed-plugin-cache.mjs ]]; then exec ${JSON.stringify(process.execPath)} "$@"; else echo "OpenClaw 2026.8.1 (${commit})"; fi\n`,
    );
    chmodSync(nodePath, 0o755);
    writeFileSync(entryPath, "// fixture\n");
    const packed = spawnSync(
      "/usr/bin/tar",
      ["-czf", archivePath, "-C", archiveRoot, `tools/${runtimeDirectory}`],
      { encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const archiveSHA256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    mkdirSync(pluginCacheDir);
    const pluginArchive = path.join(pluginCacheDir, "openclaw-codex-2026.8.1.tgz");
    writeFileSync(pluginArchive, "plugin archive\n");
    const pluginArchiveSHA256 = createHash("sha256")
      .update(readFileSync(pluginArchive))
      .digest("hex");
    const pluginCacheManifest = path.join(pluginCacheDir, "manifest.json");
    writeFileSync(
      pluginCacheManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        appVersion: "2026.8.1",
        gitCommit: commit,
        plugins: [
          {
            pluginId: "codex",
            packageName: "@openclaw/codex",
            packageVersion: "2026.8.1",
            npmSpec: "@openclaw/codex@2026.8.1",
            archiveFile: path.basename(pluginArchive),
            archiveSHA256: pluginArchiveSHA256,
          },
        ],
      })}\n`,
    );
    const pluginCacheManifestSHA256 = createHash("sha256")
      .update(readFileSync(pluginCacheManifest))
      .digest("hex");
    copyFileSync(
      "scripts/prewarmed-plugin-cache.mjs",
      path.join(root, "prewarmed-plugin-cache.mjs"),
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          appVersion: "2026.8.1",
          gitCommit: commit,
          architecture: process.arch,
          nodeVersion: "24.15.0",
          runtimeDirectory,
          archiveFile: path.basename(archivePath),
          archiveSHA256,
          pluginCacheDirectory: "prewarmed-plugin-cache",
          pluginCacheManifestFile: "manifest.json",
          pluginCacheManifestSHA256,
        },
        null,
        2,
      )}\n`,
    );
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    mkdirSync(path.join(prefix, "tools", "node-v24.16.0"), { recursive: true });
    writeFileSync(path.join(prefix, "openclaw.json"), "preserve-state\n");
    writeFileSync(path.join(prefix, "bin", "openclaw"), "old-launcher\n");
    symlinkSync("node-v24.16.0", path.join(prefix, "tools", "node"));

    const installed = spawnSync(
      "/bin/bash",
      [
        "scripts/install-cli.sh",
        "--json",
        "--no-onboard",
        "--prefix",
        prefix,
        "--prewarmed-runtime",
        archivePath,
        "--prewarmed-manifest",
        manifestPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      },
    );

    expect(installed.status, `${installed.stderr}\n${installed.stdout}`).toBe(0);
    expect(installed.stdout).toContain('"name":"prewarmed-runtime","status":"ok"');
    expect(installed.stdout).not.toContain('"name":"node","status":"start"');
    expect(installed.stdout).not.toContain('"name":"dependencies","status":"start"');
    expect(readlinkSync(path.join(prefix, "tools", "node"))).toBe(runtimeDirectory);
    expect(readFileSync(path.join(prefix, "openclaw.json"), "utf8")).toBe("preserve-state\n");
    expect(existsSync(path.join(prefix, "tools", "node-v24.16.0"))).toBe(true);
    expect(
      readFileSync(
        path.join(prefix, "cache", "prewarmed-plugins", commit, "manifest.json"),
        "utf8",
      ),
    ).toBe(readFileSync(pluginCacheManifest, "utf8"));
    const version = spawnSync(path.join(prefix, "bin", "openclaw"), ["--version"], {
      encoding: "utf8",
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(`OpenClaw 2026.8.1 (${commit})`);
    expect(existsSync(path.join(prefix, "tools", "node", "bin", "codex"))).toBe(false);
    expect(
      existsSync(
        path.join(
          prefix,
          "tools",
          "node",
          "lib",
          "node_modules",
          "openclaw",
          "dist",
          "extensions",
          "codex",
        ),
      ),
    ).toBe(false);
    expect(readFileSync(path.join(prefix, "bin", "openclaw"), "utf8")).not.toContain(
      "export PATH=",
    );

    const activeRuntime = path.join(prefix, "tools", runtimeDirectory);
    const runtimeMarker = path.join(activeRuntime, "old-runtime-marker");
    const activeLauncher = path.join(prefix, "bin", "openclaw");
    const cacheRoot = path.join(prefix, "cache", "prewarmed-plugins");
    const cacheTarget = path.join(cacheRoot, commit);
    const cacheNewPrefix = `${cacheRoot}/.${commit}.new.`;
    const cacheBackupPrefix = `${cacheRoot}/.${commit}.backup.`;
    const mockBin = path.join(root, "mock-bin");
    mkdirSync(mockBin);
    writeFileSync(runtimeMarker, "preserve-runtime\n");
    writeFileSync(activeLauncher, "preserve-launcher\n");
    writeFileSync(
      path.join(mockBin, "mv"),
      `#!/usr/bin/env bash\nsource_path="\${1:-}"\ntarget_path="\${2:-}"\nmode="\${FAIL_CACHE_MV_MODE:-}"\nif [[ "$mode" == "backup" && "$source_path" == ${JSON.stringify(cacheTarget)} && "$target_path" == ${JSON.stringify(cacheBackupPrefix)}* ]]; then exit 1; fi\nif [[ "$mode" == activation* && "$source_path" == ${JSON.stringify(cacheNewPrefix)}* && "$target_path" == ${JSON.stringify(cacheTarget)} ]]; then exit 1; fi\nif [[ "$mode" == "activation-and-restore" && "$source_path" == ${JSON.stringify(cacheBackupPrefix)}* && "$target_path" == ${JSON.stringify(cacheTarget)} ]]; then exit 1; fi\nexec /bin/mv "$@"\n`,
    );
    chmodSync(path.join(mockBin, "mv"), 0o755);

    const runFailedReinstall = (mode: string) =>
      spawnSync(
        "/bin/bash",
        [
          "scripts/install-cli.sh",
          "--json",
          "--no-onboard",
          "--prefix",
          prefix,
          "--prewarmed-runtime",
          archivePath,
          "--prewarmed-manifest",
          manifestPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${mockBin}:${process.env.PATH ?? ""}`,
            FAIL_CACHE_MV_MODE: mode,
          },
        },
      );

    const failedReinstall = runFailedReinstall("backup");
    expect(failedReinstall.status).not.toBe(0);
    expect(`${failedReinstall.stderr}\n${failedReinstall.stdout}`).toContain(
      "Could not back up the existing prewarmed plugin cache",
    );
    expect(readFileSync(runtimeMarker, "utf8")).toBe("preserve-runtime\n");
    expect(readFileSync(activeLauncher, "utf8")).toBe("preserve-launcher\n");
    expect(readFileSync(path.join(cacheTarget, "manifest.json"), "utf8")).toBe(
      readFileSync(pluginCacheManifest, "utf8"),
    );
    expect(readdirSync(cacheRoot).toSorted()).toEqual([commit]);

    const failedActivation = runFailedReinstall("activation");
    expect(failedActivation.status).not.toBe(0);
    expect(`${failedActivation.stderr}\n${failedActivation.stdout}`).toContain(
      "Could not activate the prewarmed plugin cache",
    );
    expect(readFileSync(runtimeMarker, "utf8")).toBe("preserve-runtime\n");
    expect(readFileSync(activeLauncher, "utf8")).toBe("preserve-launcher\n");
    expect(readFileSync(path.join(cacheTarget, "manifest.json"), "utf8")).toBe(
      readFileSync(pluginCacheManifest, "utf8"),
    );
    expect(readdirSync(cacheRoot).toSorted()).toEqual([commit]);

    const failedRestore = runFailedReinstall("activation-and-restore");
    expect(failedRestore.status).not.toBe(0);
    expect(failedRestore.stdout).toContain(
      '"name":"prewarmed-runtime-rollback","status":"warn","reason":"incomplete"',
    );
    expect(readFileSync(runtimeMarker, "utf8")).toBe("preserve-runtime\n");
    expect(readFileSync(activeLauncher, "utf8")).toBe("preserve-launcher\n");
    expect(
      readdirSync(cacheRoot).filter((entry) => entry.startsWith(`.${commit}.backup.`)),
    ).toHaveLength(1);
  },
);
