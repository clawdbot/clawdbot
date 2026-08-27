// ClawHub Fixture Server tests cover the local package fixture HTTP contract.
import { execFileSync, spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureClawHubPackageTrustAcknowledged } from "../../src/infra/clawhub-install-trust.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = path.resolve("scripts/e2e/lib/clawhub-fixture-server.cjs");
const PACKAGE_NAME = "@openclaw/kitchen-sink";
const PACKAGE_PATH = `/api/v1/packages/${encodeURIComponent(PACKAGE_NAME)}`;
const KITCHEN_SINK_VERSION = "0.2.5";
type FixtureServerChild = ChildProcessByStdio<null, Readable, Readable>;
const servers: FixtureServerChild[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(stopServer));
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

async function startFixtureServer(profile: string, args: string[] = [], cwd = process.cwd()) {
  const root = tempDirs.make("openclaw-clawhub-fixture-server-");
  const portFile = path.join(root, "port");
  const child = spawn(process.execPath, [SCRIPT_PATH, profile, portFile, ...args], {
    cwd,
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

function runPrepublishAssertion(
  baseUrl?: string,
  packageName?: string,
  version?: string,
  securityMode?: "required" | "absent",
  cwd = process.cwd(),
) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "assert-prepublish-requests",
      baseUrl ?? "",
      packageName ?? "",
      version ?? "",
      ...(securityMode ? [securityMode] : []),
    ],
    { cwd, encoding: "utf8", env: { ...process.env } },
  );
}

function runNoRequestsAssertion(baseUrl?: string, cwd = process.cwd()) {
  return spawnSync(process.execPath, [SCRIPT_PATH, "assert-no-requests", baseUrl ?? ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
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
      "usage: clawhub-fixture-server.cjs <catalog-search|kitchen-sink-plugin|plugins|prepublish-artifacts> <port-file> [manifest-file]",
    );
    const assertion = runPrepublishAssertion();
    expect(assertion.status).toBe(1);
    expect(assertion.stderr).toContain(
      "assert-prepublish-requests requires <base-url> <package-name> <version>",
    );
    const emptyAssertion = runNoRequestsAssertion();
    expect(emptyAssertion.status).toBe(1);
    expect(emptyAssertion.stderr).toContain("assert-no-requests requires <base-url>");
  });

  it("serves exact prepublish tarballs through the ClawHub artifact contract", async () => {
    const root = tempDirs.make("openclaw-clawhub-prepublish-");
    const isolatedCwd = tempDirs.make("openclaw-clawhub-isolated-");
    const packageDir = path.join(root, "package");
    const tarball = "openclaw-whatsapp-2026.8.1-beta.1.tgz";
    const tarballPath = path.join(root, tarball);
    const version = "2026.8.1-beta.1";
    mkdirSync(packageDir);
    writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/whatsapp", version })}\n`,
    );
    writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "whatsapp", configSchema: { type: "object" } })}\n`,
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", root, "package"]);
    const archive = readFileSync(tarballPath);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const npmIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const npmShasum = createHash("sha1").update(archive).digest("hex");
    const manifestPath = path.join(root, "prepublish-plugin-registry.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        packages: [{ name: "@openclaw/whatsapp", version, tarball, sha256 }],
      })}\n`,
    );

    const { baseUrl } = await startFixtureServer(
      "prepublish-artifacts",
      [manifestPath],
      isolatedCwd,
    );
    expect(runNoRequestsAssertion(baseUrl, isolatedCwd).status).toBe(0);
    const whatsappPath = `/api/v1/packages/${encodeURIComponent("@openclaw/whatsapp")}`;
    const detail = await fetchJson(baseUrl, whatsappPath);
    expect(detail.package).toMatchObject({
      latestVersion: version,
      runtimeId: "whatsapp",
      tags: { beta: version, latest: version },
    });
    const artifact = await fetchJson(baseUrl, `${whatsappPath}/versions/${version}/artifact`);
    expect(artifact.artifact).toMatchObject({
      artifactKind: "npm-pack",
      artifactSha256: sha256,
    });
    const securityUrl = `${baseUrl}${whatsappPath}/versions/${version}/security`;
    const fetchImpl = globalThis.fetch;
    let security: unknown;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchImpl(input, init);
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl === securityUrl) {
        security = await response.clone().json();
      }
      return response;
    });
    const trust = await ensureClawHubPackageTrustAcknowledged({
      subject: { kind: "plugin", packageName: "@openclaw/whatsapp" },
      version,
      baseUrl,
      mode: "update",
    });
    expect(security).toEqual({
      package: {
        name: "@openclaw/whatsapp",
        displayName: "@openclaw/whatsapp",
        family: "code-plugin",
      },
      release: {
        releaseId: `fixture:@openclaw/whatsapp@${version}`,
        version,
        artifactKind: "npm-pack",
        artifactSha256: sha256,
        npmIntegrity,
        npmShasum,
        npmTarballName: tarball,
        createdAt: 0,
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });
    expect(trust).toEqual({
      ok: true,
      trustInstallRecordFields: {
        clawhubTrustDisposition: "clean",
        clawhubTrustScanStatus: "clean",
        clawhubTrustCheckedAt: expect.any(String),
      },
    });
    const download = await fetch(`${baseUrl}${whatsappPath}/versions/${version}/artifact/download`);
    expect(download.headers.get("x-clawhub-artifact-sha256")).toBe(sha256);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(archive);
    expect((await fetchJson(baseUrl, "/__fixture__/requests")).requests).toEqual([
      `GET ${whatsappPath}`,
      `GET ${whatsappPath}/versions/${version}/artifact`,
      `GET ${whatsappPath}/versions/${version}/security`,
      `GET ${whatsappPath}/versions/${version}/artifact/download`,
    ]);
    expect(
      runPrepublishAssertion(baseUrl, "@openclaw/whatsapp", version, undefined, isolatedCwd).status,
    ).toBe(0);
    const unexpectedStartupRequest = runNoRequestsAssertion(baseUrl, isolatedCwd);
    expect(unexpectedStartupRequest.status).toBe(1);
    expect(unexpectedStartupRequest.stderr).toContain("unexpected ClawHub fixture requests");
    expect((await fetch(`${baseUrl}${whatsappPath}/versions/0.0.0/artifact`)).status).toBe(404);
    const mismatch = runPrepublishAssertion(baseUrl, "@openclaw/whatsapp", version);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("unexpected ClawHub fixture requests");
  });

  it("serves separate plugin-family and skill search fixtures", async () => {
    const { baseUrl } = await startFixtureServer("catalog-search");

    const codePlugins = await fetchJson(
      baseUrl,
      "/api/v1/packages/search?q=calendar&family=code-plugin&limit=5",
    );
    expect(codePlugins.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          score: 4,
          package: expect.objectContaining({
            name: "@acme/calendar",
            family: "code-plugin",
          }),
        }),
      ]),
    );

    const bundlePlugins = await fetchJson(
      baseUrl,
      "/api/v1/packages/search?q=calendar&family=bundle-plugin&limit=5",
    );
    expect(bundlePlugins.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          score: 12,
          package: expect.objectContaining({
            name: "@acme/calendar",
            family: "bundle-plugin",
          }),
        }),
      ]),
    );

    const skills = await fetchJson(baseUrl, "/api/v1/search?q=calendar&limit=5");
    expect(skills.results).toEqual([
      expect.objectContaining({
        score: 99,
        slug: "calendar-skill",
      }),
    ]);

    const empty = await fetchJson(
      baseUrl,
      "/api/v1/packages/search?q=empty&family=code-plugin&limit=5",
    );
    expect(empty).toEqual({ results: [] });

    const unavailable = await fetch(
      `${baseUrl}/api/v1/packages/search?q=unavailable&family=code-plugin&limit=5`,
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "catalog unavailable" });
  });
});
