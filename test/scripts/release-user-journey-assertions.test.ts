// Release User Journey Assertions tests cover release user journey assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runReleaseUserJourneyAssertion,
  waitForClickClackSocket,
} from "../../scripts/e2e/lib/release-user-journey/assertions.mjs";
import { withEnvAsync } from "../../src/test-utils/env.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-user-journey/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";

function nodeOptionsWithoutExperimentalWarnings(extra?: string): string {
  const current = [process.env.NODE_OPTIONS, extra].filter(Boolean).join(" ");
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

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
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(options.env?.NODE_OPTIONS),
    },
    killSignal: "SIGKILL",
    timeout: options.timeoutMs,
  });
}

async function waitUntil(matches: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (matches()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTcpFixtureServer(handler: (socket: Socket) => void): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("release user journey assertions", () => {
  it("rejects loose mock OpenAI port args", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");

    try {
      const result = runAssertion(home, ["configure-mock-model", "1e3"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mock OpenAI port must be a TCP port from 1 to 65535");
      expect(result.stderr).toContain('"1e3"');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("scans large files when checking release user journey output text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const outputPath = path.join(root, "output.log");

    try {
      const needlePrefix = "journey-plugin";
      writeFileSync(
        outputPath,
        `${"x".repeat(64 * 1024 - needlePrefix.length)}${needlePrefix}-a:pong\n`,
        "utf8",
      );

      const result = runAssertion(home, [
        "assert-file-contains",
        outputPath,
        "journey-plugin-a:pong",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds release user journey output assertion diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const outputPath = path.join(root, "output.log");

    try {
      writeFileSync(
        outputPath,
        `DO_NOT_DUMP_OLD_OUTPUT${"x".repeat(70 * 1024)}\nrecent output tail\n`,
        "utf8",
      );

      const result = runAssertion(home, ["assert-file-contains", outputPath, "missing"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Output tail:");
      expect(result.stderr).toContain("recent output tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_OUTPUT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects oversized JSON artifacts before parsing release user journey config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const configPath = path.join(home, ".openclaw", "openclaw.json");

    try {
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        `DO_NOT_DUMP_OLD_JSON${"x".repeat(2 * 1024 * 1024)}\nrecent json tail`,
        "utf8",
      );

      const result = runAssertion(home, ["configure-mock-model", "18080"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("JSON artifact exceeded");
      expect(result.stderr).toContain("recent json tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_JSON");
      expect(result.stderr.length).toBeLessThan(80 * 1024);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
    const server = await startTcpFixtureServer((socket) => {
      const body = JSON.stringify({ socketCount: 1 });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });

    try {
      await expect(
        withEnvAsync({ HOME: home, OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000" }, () =>
          runReleaseUserJourneyAssertion("wait-clickclack-socket", [
            `http://127.0.0.1:${server.port}`,
            "1",
          ]),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("cancels successful ClickClack inbound response bodies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    let socketClosed = false;
    const server = await startTcpFixtureServer((socket) => {
      socket.on("close", () => {
        socketClosed = true;
      });
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nleft-open");
    });

    try {
      await expect(
        withEnvAsync({ HOME: home, OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000" }, () =>
          runReleaseUserJourneyAssertion("post-clickclack-inbound", [
            `http://127.0.0.1:${server.port}`,
            "hello",
          ]),
        ),
      ).resolves.toBeUndefined();
      await waitUntil(() => socketClosed, "ClickClack inbound socket close");
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds stalled ClickClack fixture HTTP probes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const server = await startTcpFixtureServer((socket) =>
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"),
    );

    try {
      const startedAt = Date.now();
      await expect(
        withEnvAsync({ HOME: home, OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "100" }, () =>
          waitForClickClackSocket({
            baseUrl: `http://127.0.0.1:${server.port}`,
            pollIntervalMs: 20,
            timeoutMs: 150,
          }),
        ),
      ).rejects.toThrow("Timed out waiting for ClickClack websocket connection");
      expect(Date.now() - startedAt).toBeLessThan(750);
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose HTTP timeout env values instead of parsing prefixes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const server = await startTcpFixtureServer((socket) =>
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"),
    );

    try {
      await expect(
        withEnvAsync({ HOME: home, OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "100ms" }, () =>
          runReleaseUserJourneyAssertion("wait-clickclack-socket", [
            `http://127.0.0.1:${server.port}`,
            "1",
          ]),
        ),
      ).rejects.toThrow(
        'OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS must be a positive integer. Got: "100ms"',
      );
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose ClickClack wait timeout args instead of parsing prefixes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const statePath = path.join(root, "state.json");

    try {
      await expect(
        withEnvAsync({ HOME: home }, () =>
          runReleaseUserJourneyAssertion("wait-clickclack-socket", ["http://127.0.0.1:9", "1e3"]),
        ),
      ).rejects.toThrow(
        'ClickClack websocket timeout seconds must be a positive integer. Got: "1e3"',
      );
      await expect(
        withEnvAsync({ HOME: home }, () =>
          runReleaseUserJourneyAssertion("wait-clickclack-reply", [
            statePath,
            "OPENCLAW_E2E_OK",
            "30s",
          ]),
        ),
      ).rejects.toThrow('ClickClack reply timeout seconds must be a positive integer. Got: "30s"');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds ClickClack fixture error response bodies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const server = await startTcpFixtureServer((socket) => {
      const body = "x".repeat(128);
      socket.end(
        `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });

    try {
      await expect(
        withEnvAsync(
          {
            HOME: home,
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES: "16",
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000",
          },
          () =>
            runReleaseUserJourneyAssertion("post-clickclack-inbound", [
              `http://127.0.0.1:${server.port}`,
              "hello",
            ]),
        ),
      ).rejects.toThrow("ClickClack inbound response body exceeded 16 bytes");
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the ClickClack HTTP timeout active while reading error bodies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const server = await startTcpFixtureServer((socket) => {
      socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\npartial");
    });

    try {
      await expect(
        withEnvAsync(
          {
            HOME: home,
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "25",
          },
          () =>
            runReleaseUserJourneyAssertion("post-clickclack-inbound", [
              `http://127.0.0.1:${server.port}`,
              "hello",
            ]),
        ),
      ).rejects.toThrow(`http://127.0.0.1:${server.port}/fixture/inbound timed out after 25ms`);
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose body byte env values instead of parsing prefixes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const server = await startTcpFixtureServer((socket) => {
      const body = "x".repeat(128);
      socket.end(
        `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });

    try {
      await expect(
        withEnvAsync(
          {
            HOME: home,
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES: "16bytes",
            OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: "1000",
          },
          () =>
            runReleaseUserJourneyAssertion("post-clickclack-inbound", [
              `http://127.0.0.1:${server.port}`,
              "hello",
            ]),
        ),
      ).rejects.toThrow(
        'OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES must be a positive integer. Got: "16bytes"',
      );
    } finally {
      await server.stop();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
