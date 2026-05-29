import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/plugins/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertionAsync(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`assertion helper did not exit: ${args.join(" ")}`));
      }, 2_000);
      timeout.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

describe("plugins Docker assertions", () => {
  it("keeps sweep artifact paths aligned with the assertion scratch root", () => {
    const scripts = [
      "scripts/e2e/lib/plugins/sweep.sh",
      "scripts/e2e/lib/plugins/marketplace.sh",
      "scripts/e2e/lib/plugins/clawhub.sh",
    ];

    for (const scriptPath of scripts) {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("OPENCLAW_PLUGINS_TMP_DIR");
      expect(script).not.toMatch(
        /\/tmp\/(?:plugins|marketplace|demo-plugin|is-number|openclaw-plugin|openclaw-clawhub)/,
      );
    }
  });

  it("uses the configured scratch root and resolves Windows home-relative install paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, "managed-plugin");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2.json"), {
        plugins: [{ id: "demo-plugin-tgz", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins2-inspect.json"), {
        gatewayMethods: ["demo.tgz"],
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          "demo-plugin-tgz": {
            source: "archive",
            installPath: String.raw`~\managed-plugin`,
          },
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("compares local plugin source paths by canonical path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const sourceParent = path.join(root, "source");
    const sourcePath = `${sourceParent}//plugin`;
    const normalizedSourcePath = path.join(sourceParent, "plugin");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-dir");
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins3.json"), {
        plugins: [{ id: "demo-plugin-dir", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins3-inspect.json"), {
        gatewayMethods: ["demo.dir"],
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          "demo-plugin-dir": {
            source: "path",
            sourcePath: normalizedSourcePath,
            installPath,
          },
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-dir", sourcePath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("still requires archive managed install directories to be removed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-tgz");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2-uninstalled.json"), { plugins: [] });
      writeFileSync(path.join(scratchRoot, "plugins2-install-path.txt"), installPath, "utf8");
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz-removed"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed install path still exists after uninstall");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("times out stalled ClawHub package metadata requests", async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "25",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight for @openclaw/kitchen-sink timed out after 25ms",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("times out stalled ClawHub package metadata bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("{");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "75",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight response for @openclaw/kitchen-sink timed out after 75ms",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("bounds ClawHub package metadata response bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("x".repeat(128));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES: "16",
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "1000",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight response for @openclaw/kitchen-sink response body exceeded 16 bytes",
      );
      expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
