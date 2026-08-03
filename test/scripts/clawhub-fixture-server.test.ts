// ClawHub Fixture Server tests cover the local package fixture HTTP contract.
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/clawhub-fixture-server.cjs";
const PACKAGE_NAME = "@openclaw/kitchen-sink";
const PACKAGE_PATH = `/api/v1/packages/${encodeURIComponent(PACKAGE_NAME)}`;
const KITCHEN_SINK_VERSION = "0.2.5";
const tempDirs: string[] = [];
type FixtureServerChild = ChildProcessByStdio<null, Readable, Readable>;
const servers: FixtureServerChild[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
  cleanupTempDirs(tempDirs);
});

function collectStream(stream: NodeJS.ReadableStream) {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
  });
  return () => text;
}

async function stopServer(child: FixtureServerChild) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function startFixtureServer(profile: string) {
  const root = makeTempDir(tempDirs, "openclaw-clawhub-fixture-server-");
  const portFile = path.join(root, "port");
  const child = spawn(process.execPath, [SCRIPT_PATH, profile, portFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readStdout = collectStream(child.stdout);
  const readStderr = collectStream(child.stderr);
  servers.push(child);

  // Preserve the 2.5-second startup budget while detecting the port file sooner.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8"));
      if (Number.isInteger(port) && port > 0) {
        return { baseUrl: `http://127.0.0.1:${port}` };
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited early: stdout=${readStdout()} stderr=${readStderr()}`);
    }
    await delay(5);
  }

  throw new Error(`fixture server did not write a port: stderr=${readStderr()}`);
}

async function fetchJson(baseUrl: string, requestPath: string) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("ClawHub fixture server", () => {
  it("serves package metadata and npm-pack artifacts for kitchen-sink fixtures", async () => {
    const { baseUrl } = await startFixtureServer("kitchen-sink-plugin");

    const packageDetail = await fetchJson(baseUrl, PACKAGE_PATH);
    expect(packageDetail.package.name).toBe(PACKAGE_NAME);
    expect(packageDetail.package.latestVersion).toBe(KITCHEN_SINK_VERSION);
    expect(packageDetail.package.artifact.format).toBe("tgz");

    const versionDetail = await fetchJson(
      baseUrl,
      `${PACKAGE_PATH}/versions/${KITCHEN_SINK_VERSION}/artifact`,
    );
    expect(versionDetail.artifact).toMatchObject({
      artifactKind: "npm-pack",
      packageName: PACKAGE_NAME,
      source: "clawhub",
      version: KITCHEN_SINK_VERSION,
    });

    const artifactResponse = await fetch(
      `${baseUrl}${PACKAGE_PATH}/versions/${KITCHEN_SINK_VERSION}/artifact/download`,
    );
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("x-clawhub-artifact-type")).toBe("npm-pack-tarball");
    expect(artifactResponse.headers.get("x-clawhub-artifact-sha256")).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.from(await artifactResponse.arrayBuffer()).length).toBeGreaterThan(100);

    const missingResponse = await fetch(`${baseUrl}/missing`);
    expect(missingResponse.status).toBe(404);
    const methodResponse = await fetch(`${baseUrl}${PACKAGE_PATH}`, { method: "POST" });
    expect(methodResponse.status).toBe(405);
  });

  it("rejects missing startup arguments before binding a fixture server", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "usage: clawhub-fixture-server.cjs <kitchen-sink-plugin|plugins> <port-file>",
    );
  });
});
