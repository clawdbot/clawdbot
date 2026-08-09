import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { searchSkillsFromClawHub } from "../skills/lifecycle/clawhub.js";
import { runPluginsSearchCommand } from "./plugins-search-command.js";

const SCRIPT_PATH = "scripts/e2e/lib/clawhub-fixture-server.cjs";
const servers: Array<ChildProcessByStdio<null, Readable, Readable>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const previousClawHubUrl = process.env.OPENCLAW_CLAWHUB_URL;
const previousClawHubConfigPath = process.env.CLAWHUB_CONFIG_PATH;
const previousClawHubToken = process.env.CLAWHUB_TOKEN;
const previousClawHubAuthToken = process.env.CLAWHUB_AUTH_TOKEN;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
  if (previousClawHubUrl === undefined) {
    delete process.env.OPENCLAW_CLAWHUB_URL;
  } else {
    process.env.OPENCLAW_CLAWHUB_URL = previousClawHubUrl;
  }
  if (previousClawHubConfigPath === undefined) {
    delete process.env.CLAWHUB_CONFIG_PATH;
  } else {
    process.env.CLAWHUB_CONFIG_PATH = previousClawHubConfigPath;
  }
  if (previousClawHubToken === undefined) {
    delete process.env.CLAWHUB_TOKEN;
  } else {
    process.env.CLAWHUB_TOKEN = previousClawHubToken;
  }
  if (previousClawHubAuthToken === undefined) {
    delete process.env.CLAWHUB_AUTH_TOKEN;
  } else {
    process.env.CLAWHUB_AUTH_TOKEN = previousClawHubAuthToken;
  }
});

async function stopServer(child: ChildProcessByStdio<null, Readable, Readable>) {
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

async function startFixtureServer() {
  const root = tempDirs.make("clawhub-search-e2e-");
  const portFile = path.join(root, "port");
  const child = spawn(process.execPath, [SCRIPT_PATH, "catalog-search", portFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8"));
      if (Number.isInteger(port) && port > 0) {
        return { baseUrl: `http://127.0.0.1:${port}`, root };
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited early: ${stderr}`);
    }
    await delay(5);
  }
  throw new Error(`fixture server did not write a port: ${stderr}`);
}

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const runtime: RuntimeEnv = {
    log: (...args) => logs.push(args.map(String).join(" ")),
    error: (...args) => errors.push(args.map(String).join(" ")),
    exit: (code) => {
      exitCode = code;
    },
  };
  return {
    runtime,
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
  };
}

async function readRequestLog(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/__fixture__/requests`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { requests: string[] };
  return body.requests;
}

describe("openclaw plugins search ClawHub E2E", () => {
  it("keeps plugin discovery separate from skills and surfaces empty and failed lookups", async () => {
    const { baseUrl, root } = await startFixtureServer();
    process.env.OPENCLAW_CLAWHUB_URL = baseUrl;
    process.env.CLAWHUB_CONFIG_PATH = path.join(root, "missing-config.json");
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;

    const terminal = createRuntime();
    await runPluginsSearchCommand("calendar", { limit: 5 }, terminal.runtime);
    const terminalOutput = terminal.logs.join("\n");
    expect(terminal.exitCode).toBeUndefined();
    expect(
      terminalOutput.split("\n").filter((line) => line.startsWith("@acme/calendar  ")),
    ).toHaveLength(1);
    expect(terminalOutput).toContain("bundle-plugin | official | v3.0.0");
    expect(terminalOutput).toContain("Install: openclaw plugins install clawhub:@acme/calendar");
    expect(terminalOutput).not.toContain("calendar-skill");

    const json = createRuntime();
    await runPluginsSearchCommand("calendar", { json: true, limit: 5 }, json.runtime);
    const jsonOutput = JSON.parse(json.logs.join("\n")) as {
      results: Array<{ score: number; package: { name: string; family: string } }>;
    };
    expect(jsonOutput.results[0]).toMatchObject({
      score: 12,
      package: {
        name: "@acme/calendar",
        family: "bundle-plugin",
      },
    });
    expect(
      jsonOutput.results.filter((entry) => entry.package.name === "@acme/calendar"),
    ).toHaveLength(1);

    const skills = await searchSkillsFromClawHub({
      query: "calendar",
      limit: 5,
      baseUrl,
    });
    expect(skills).toEqual([
      expect.objectContaining({
        score: 99,
        slug: "calendar-skill",
      }),
    ]);

    const empty = createRuntime();
    await runPluginsSearchCommand("empty", { limit: 5 }, empty.runtime);
    expect(empty.exitCode).toBeUndefined();
    expect(empty.logs).toEqual(["No ClawHub plugins found."]);

    const unavailable = createRuntime();
    await runPluginsSearchCommand("unavailable", { limit: 5 }, unavailable.runtime);
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.errors.join("\n")).toContain("catalog unavailable");

    const requests = await readRequestLog(baseUrl);
    expect(requests).toEqual(
      expect.arrayContaining([
        "GET /api/v1/packages/search?q=calendar&family=code-plugin&limit=5",
        "GET /api/v1/packages/search?q=calendar&family=bundle-plugin&limit=5",
        "GET /api/v1/search?q=calendar&limit=5",
      ]),
    );
  }, 30_000);
});
