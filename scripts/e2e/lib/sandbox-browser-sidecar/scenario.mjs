import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";

const execFileAsync = promisify(execFile);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const root = requireEnv("OPENCLAW_E2E_ROOT");
const sandboxImage = requireEnv("OPENCLAW_E2E_SANDBOX_IMAGE");
const browserImage = requireEnv("OPENCLAW_E2E_BROWSER_IMAGE");
const sandboxPrefix = requireEnv("OPENCLAW_E2E_SANDBOX_PREFIX");
const browserPrefix = requireEnv("OPENCLAW_E2E_BROWSER_PREFIX");
const browserNetwork = requireEnv("OPENCLAW_E2E_BROWSER_NETWORK");
const stateDir = path.join(root, "state");
const workspaceDir = path.join(root, "workspace");
const sandboxRoot = path.join(root, "sandboxes");
const configPath = path.join(stateDir, "openclaw.json");
const sessionKey = "agent:main:sandbox-browser-sidecar";
const browserToken = `sandbox-browser-sidecar-${process.pid}`;
const marker = `OPENCLAW_SANDBOX_BROWSER_SIDECAR_${process.pid}`;
const ownedContainerNames = new Set();

process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = configPath;

const config = {
  gateway: {
    auth: {
      mode: "token",
      token: browserToken,
    },
  },
  browser: {
    enabled: true,
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: ["browser"],
      },
    },
  },
  agents: {
    defaults: {
      workspace: workspaceDir,
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: sandboxRoot,
        docker: {
          image: sandboxImage,
          containerPrefix: sandboxPrefix,
          network: "none",
          extraHosts: ["host.docker.internal:host-gateway"],
        },
        browser: {
          enabled: true,
          image: browserImage,
          containerPrefix: browserPrefix,
          network: browserNetwork,
          headless: true,
          noVncEnabled: false,
          autoStart: true,
          autoStartTimeoutMs: 120_000,
        },
      },
    },
  },
};

async function run(command, args, options = {}) {
  return await execFileAsync(command, args, {
    cwd: "/app",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function docker(args, options) {
  return await run("docker", args, options);
}

async function listTaskContainers() {
  const { stdout } = await docker(["ps", "-a", "--format", "{{.Names}}"]);
  return stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((name) => name.startsWith(sandboxPrefix) || name.startsWith(browserPrefix));
}

async function cleanupTaskResources() {
  const names = new Set([...ownedContainerNames, ...(await listTaskContainers().catch(() => []))]);
  for (const name of names) {
    await docker(["rm", "-f", name]).catch(() => undefined);
  }
  await docker(["network", "rm", browserNetwork]).catch(() => undefined);
}

function requestJson(baseUrl, requestPath, init = {}) {
  return fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${browserToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }).then(async (response) => {
    const text = await response.text();
    assert.equal(response.ok, true, `${requestPath} failed (${response.status}): ${text}`);
    return text ? JSON.parse(text) : {};
  });
}

async function startFixtureServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><main><h1>${marker}</h1></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not bind a TCP port");
  return {
    server,
    port: address.port,
  };
}

await fs.mkdir(process.env.HOME, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(workspaceDir, { recursive: true });
await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const fixture = await startFixtureServer();

try {
  const params = {
    config,
    agentId: "main",
    sessionKey,
    workspaceDir,
  };
  const [first, second] = await Promise.all([
    resolveSandboxContext(params),
    resolveSandboxContext(params),
  ]);

  assert(first, "first sandbox context was not provisioned");
  assert(second, "second sandbox context was not provisioned");
  assert(first.browser, "first sandbox browser context was not provisioned");
  assert(second.browser, "second sandbox browser context was not provisioned");
  assert.equal(first.containerName, second.containerName, "concurrent calls split sandbox runtime");
  assert.equal(
    first.browser.containerName,
    second.browser.containerName,
    "concurrent calls split browser runtime",
  );
  assert.equal(
    first.browser.bridgeUrl,
    second.browser.bridgeUrl,
    "concurrent calls split browser bridge",
  );
  const { stdout: gatewayStdout } = await docker([
    "network",
    "inspect",
    "-f",
    "{{(index .IPAM.Config 0).Gateway}}",
    browserNetwork,
  ]);
  const gateway = gatewayStdout.trim();
  assert(gateway, "browser Docker network did not report a gateway");
  const fixtureUrl = `http://${gateway}:${fixture.port}/`;
  ownedContainerNames.add(first.containerName);
  ownedContainerNames.add(first.browser.containerName);

  const unauthenticated = await fetch(`${first.browser.bridgeUrl}/`);
  assert.equal(unauthenticated.status, 401, "browser bridge accepted an unauthenticated request");
  await unauthenticated.body?.cancel();

  const opened = await requestJson(first.browser.bridgeUrl, "/tabs/open", {
    method: "POST",
    body: JSON.stringify({ url: fixtureUrl }),
  });
  assert.equal(typeof opened.targetId, "string", "bridge did not return an opened tab");

  const snapshot = await requestJson(
    first.browser.bridgeUrl,
    `/snapshot?format=ai&targetId=${encodeURIComponent(opened.targetId)}`,
  );
  assert.equal(snapshot.format, "ai", "bridge returned the wrong snapshot format");
  assert.match(snapshot.snapshot, new RegExp(marker), "snapshot did not contain the HTML marker");

  const { stdout: listStdout } = await run("openclaw", ["sandbox", "list", "--browser", "--json"]);
  const listed = JSON.parse(listStdout);
  const browserEntry = listed.browsers?.find(
    (entry) => entry.containerName === first.browser.containerName,
  );
  assert(browserEntry, "packaged sandbox list did not report the browser container");
  assert.equal(browserEntry.sessionKey, sessionKey);
  assert.equal(browserEntry.running, true);

  await run("openclaw", ["sandbox", "recreate", "--browser", "--session", sessionKey, "--force"]);
  const remaining = await listTaskContainers();
  assert(
    !remaining.includes(first.browser.containerName),
    "packaged recreate kept browser container",
  );
  assert(remaining.includes(first.containerName), "packaged recreate removed normal sandbox");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      sandboxContainer: first.containerName,
      browserContainer: first.browser.containerName,
      marker,
    })}\n`,
  );
} finally {
  await new Promise((resolve) => {
    fixture.server.close(resolve);
  });
  await cleanupTaskResources();
}

// resolveSandboxContext owns an in-process bridge server that intentionally
// stays live for agent reuse. This standalone scenario has finished its cleanup.
process.exit(0);
