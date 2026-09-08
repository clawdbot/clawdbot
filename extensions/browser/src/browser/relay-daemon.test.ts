import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";

const TOKEN = relayTestKey(1);

const tempStateDirs: string[] = [];
const savedStateDirEnv = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  if (savedStateDirEnv === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedStateDirEnv;
  }
  await Promise.all(
    tempStateDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Point readExtensionRelayToken() at an isolated credentials dir holding TOKEN. */
async function stageRelaySecret(): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-daemon-"));
  tempStateDirs.push(stateDir);
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(credentialsDir, "browser-extension-relay.secret"), `${TOKEN}\n`, {
    mode: 0o600,
  });
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

describe("runExtensionRelayDaemon", () => {
  it("refuses to start without a relay credential", async () => {
    const run = await runExtensionRelayDaemon({ port: 0, readToken: () => null });
    expect(run.port).toBeNull();
    await expect(run.done).resolves.toBe("no-credential");
  });

  it("exits quietly when the relay port is already served", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const run = await runExtensionRelayDaemon({ port, readToken: () => TOKEN });
      expect(run.port).toBeNull();
      await expect(run.done).resolves.toBe("port-in-use");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("serves the relay until the idle grace elapses with no peers", async () => {
    const run = await runExtensionRelayDaemon({
      port: 0,
      readToken: () => TOKEN,
      idleExitMs: 60,
      pollMs: 15,
    });
    expect(run.port).toBeGreaterThan(0);
    // The bound socket answers while the daemon is alive.
    const served = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: run.port ?? 0 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(served).toBe(true);
    await expect(run.done).resolves.toBe("idle");
  });

  it("is v2-only by default: rejects a VALID legacy Bearer credential so a squatter cannot harvest the secret", async () => {
    await stageRelaySecret();
    const run = await runExtensionRelayDaemon({
      port: 0,
      idleExitMs: 60_000,
      pollMs: 60_000,
    });
    try {
      // Even the correct secret over legacy one-directional auth is refused
      // when allowLegacyAuth is not explicitly enabled.
      const status = await fetch(`http://127.0.0.1:${run.port}/json/version`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(status.status).toBe(401);
    } finally {
      run.stop();
      await run.done;
    }
  });

  it("honors an explicit allowLegacyAuth opt-in", async () => {
    await stageRelaySecret();
    const run = await runExtensionRelayDaemon({
      port: 0,
      allowLegacyAuth: true,
      idleExitMs: 60_000,
      pollMs: 60_000,
    });
    try {
      // With legacy auth enabled the credential is accepted; the request then
      // reaches the "extension not connected" state (503) rather than 401.
      const status = await fetch(`http://127.0.0.1:${run.port}/json/version`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(status.status).toBe(503);
    } finally {
      run.stop();
      await run.done;
    }
  });

  it("stops on demand", async () => {
    const run = await runExtensionRelayDaemon({
      port: 0,
      readToken: () => TOKEN,
      idleExitMs: 60_000,
      pollMs: 60_000,
    });
    expect(run.port).toBeGreaterThan(0);
    run.stop();
    await expect(run.done).resolves.toBe("stopped");
  });
});
