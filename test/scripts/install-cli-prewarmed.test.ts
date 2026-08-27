import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
    const prefix = path.join(root, "prefix");
    const home = path.join(root, "home");

    mkdirSync(path.dirname(nodePath), { recursive: true });
    mkdirSync(path.dirname(entryPath), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      nodePath,
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo v24.15.0; else echo "OpenClaw 2026.8.1 (${commit})"; fi\n`,
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
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appVersion: "2026.8.1",
          gitCommit: commit,
          architecture: process.arch,
          nodeVersion: "24.15.0",
          runtimeDirectory,
          archiveFile: path.basename(archivePath),
          archiveSHA256,
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
  },
);
