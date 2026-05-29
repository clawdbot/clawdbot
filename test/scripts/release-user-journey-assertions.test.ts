import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-user-journey/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(
  home: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ...options.env,
    },
    killSignal: "SIGKILL",
    timeout: options.timeoutMs,
  });
}

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf8");
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const startedAt = Date.now();
  while (child.exitCode === null && Date.now() - startedAt < 1000) {
    await delay(25);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function startTcpFixture(portPath: string, connectionHandlerSource: string) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import net from "node:net";',
        'import fs from "node:fs";',
        `const server = net.createServer(${connectionHandlerSource});`,
        'server.listen(0, "127.0.0.1", () => {',
        "  const address = server.address();",
        "  fs.writeFileSync(process.env.PORT_FILE, String(address.port));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, PORT_FILE: portPath },
      stdio: "pipe",
    },
  );
}

describe("release user journey assertions", () => {
  it("fails when uninstall leaves the managed plugin directory behind", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const pluginId = "journey-plugin-a";
    const installPath = path.join(home, ".openclaw", "extensions", pluginId);
    const installPathFile = path.join(root, "install-path.txt");

    try {
      writeJson(path.join(home, ".openclaw", "openclaw.json"), {
        plugins: {
          entries: {},
          allow: [],
          deny: [],
        },
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });
      mkdirSync(installPath, { recursive: true });
      writeFileSync(installPathFile, installPath, "utf8");

      const result = runAssertion(home, ["assert-plugin-uninstalled", pluginId, installPathFile]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed plugin directory still present");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("passes after uninstall clears config, records, and managed files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const installPathFile = path.join(root, "install-path.txt");

    try {
      writeJson(path.join(home, ".openclaw", "openclaw.json"), {
        plugins: {
          entries: {},
          allow: [],
          deny: [],
        },
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });
      writeFileSync(
        installPathFile,
        path.join(home, ".openclaw", "extensions", "journey-plugin-a"),
        "utf8",
      );

      const result = runAssertion(home, [
        "assert-plugin-uninstalled",
        "journey-plugin-a",
        installPathFile,
      ]);

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("remembers the installed plugin path from the install record", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const pluginId = "journey-plugin-a";
    const sourcePath = path.join(root, "source", pluginId);
    const installPath = path.join(home, ".openclaw", "extensions", pluginId);
    const installPathFile = path.join(root, "install-path.txt");
    const sourcePathFile = path.join(root, "source-path.txt");

    try {
      mkdirSync(sourcePath, { recursive: true });
      mkdirSync(installPath, { recursive: true });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          [pluginId]: {
            source: "path",
            sourcePath,
            installPath,
          },
        },
      });

      const result = runAssertion(home, [
        "remember-plugin-install-path",
        pluginId,
        installPathFile,
        sourcePathFile,
        sourcePath,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts ready ClickClack fixture state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const portPath = path.join(root, "port.txt");
    const server = startTcpFixture(
      portPath,
      [
        "(socket) => {",
        "  const body = JSON.stringify({ socketCount: 1 });",
        "  socket.end(`HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
        "}",
      ].join("\n"),
    );

    try {
      const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
      const result = runAssertion(
        home,
        ["wait-clickclack-socket", `http://127.0.0.1:${port}`, "1"],
        {
          env: { OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000" },
          timeoutMs: 2500,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds stalled ClickClack fixture HTTP probes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const portPath = path.join(root, "port.txt");
    const server = startTcpFixture(
      portPath,
      '(socket) => socket.write("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n")',
    );

    try {
      const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
      const startedAt = Date.now();
      const result = runAssertion(
        home,
        ["wait-clickclack-socket", `http://127.0.0.1:${port}`, "1"],
        {
          env: { OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "100" },
          timeoutMs: 2500,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).not.toBe("SIGKILL");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Timed out waiting for ClickClack websocket connection");
      expect(Date.now() - startedAt).toBeLessThan(2500);
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose HTTP timeout env values instead of parsing prefixes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const portPath = path.join(root, "port.txt");
    const server = startTcpFixture(
      portPath,
      '(socket) => socket.write("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n")',
    );

    try {
      const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
      const result = runAssertion(
        home,
        ["wait-clickclack-socket", `http://127.0.0.1:${port}`, "1"],
        {
          env: { OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "100ms" },
          timeoutMs: 500,
        },
      );

      expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
      expect(result.signal).toBe("SIGKILL");
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds ClickClack fixture error response bodies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const portPath = path.join(root, "port.txt");
    const server = startTcpFixture(
      portPath,
      [
        "(socket) => {",
        '  const body = "x".repeat(128);',
        "  socket.end(`HTTP/1.1 500 Internal Server Error\\r\\nContent-Type: text/plain\\r\\nContent-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
        "}",
      ].join("\n"),
    );

    try {
      const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
      const result = runAssertion(
        home,
        ["post-clickclack-inbound", `http://127.0.0.1:${port}`, "hello"],
        {
          env: {
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES: "16",
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000",
          },
          timeoutMs: 2500,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).not.toBe("SIGKILL");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ClickClack inbound response body exceeded 16 bytes");
      expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose body byte env values instead of parsing prefixes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const portPath = path.join(root, "port.txt");
    const server = startTcpFixture(
      portPath,
      [
        "(socket) => {",
        '  const body = "x".repeat(128);',
        "  socket.end(`HTTP/1.1 500 Internal Server Error\\r\\nContent-Type: text/plain\\r\\nContent-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
        "}",
      ].join("\n"),
    );

    try {
      const port = Number.parseInt((await waitForFile(portPath)).trim(), 10);
      const result = runAssertion(
        home,
        ["post-clickclack-inbound", `http://127.0.0.1:${port}`, "hello"],
        {
          env: {
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES: "16bytes",
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000",
          },
          timeoutMs: 2500,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).not.toBe("SIGKILL");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fixture inbound failed: 500");
      expect(result.stderr).not.toContain("response body exceeded 16 bytes");
    } finally {
      await stopChild(server);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
