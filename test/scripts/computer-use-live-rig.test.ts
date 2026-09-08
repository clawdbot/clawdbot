import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rigScriptSource = path.resolve("scripts/dev/computer-use-macos-live-rig.sh");
const fixtureRoots: string[] = [];

function runGit(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

function createRigRepository(): {
  root: string;
  script: string;
  fakeBin: string;
  app: string;
  fixture: string;
  proof: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-computer-use-rig-"));
  fixtureRoots.push(root);
  const scriptsDev = path.join(root, "scripts", "dev");
  const fakeBin = path.join(root, "fake-bin");
  const app = path.join(root, "OpenClaw.app");
  const appExecutable = path.join(app, "Contents", "MacOS", "OpenClaw");
  mkdirSync(scriptsDev, { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(path.dirname(appExecutable), { recursive: true });

  const script = path.join(scriptsDev, "computer-use-macos-live-rig.sh");
  const fixture = path.join(scriptsDev, "computer-use-linux-x11-fixture.py");
  const proof = path.join(scriptsDev, "computer-use-macos-live-proof.ts");
  copyFileSync(rigScriptSource, script);
  chmodSync(script, 0o755);
  writeFileSync(fixture, "# committed fixture\n");
  const captureInvocation = `#!${process.execPath}
console.log(JSON.stringify({
  args: process.argv.slice(2),
  config: process.env.OPENCLAW_CONFIG_PATH,
  state: process.env.OPENCLAW_STATE_DIR,
  profile: process.env.OPENCLAW_PROFILE,
  ambient: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PORT"].filter(key => process.env[key] !== undefined),
}));
`;
  writeFileSync(proof, captureInvocation);
  writeFileSync(path.join(root, "scripts", "run-node.mjs"), captureInvocation);
  writeExecutable(appExecutable, captureInvocation);
  writeExecutable(path.join(fakeBin, "defaults"), '#!/bin/sh\n[ "$1" != read ]\n');
  mkdirSync(path.join(root, "home"));
  writeExecutable(path.join(fakeBin, "codesign"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(fakeBin, "uname"), "#!/bin/sh\necho Linux\n");
  writeExecutable(path.join(fakeBin, "xdotool"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(fakeBin, "xdpyinfo"), "#!/bin/sh\nexit 0\n");

  runGit(root, "init", "-q");
  runGit(root, "config", "user.name", "OpenClaw Test");
  runGit(root, "config", "user.email", "openclaw-test@example.com");
  runGit(root, "add", "scripts");
  runGit(root, "commit", "-q", "-m", "fixture");

  return { root, script, fakeBin, app, fixture, proof };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

function runRig(params: { root: string; script: string; fakeBin: string; args: string[] }) {
  return spawnSync("bash", [params.script, ...params.args], {
    cwd: params.root,
    encoding: "utf8",
    env: {
      HOME: path.join(params.root, "home"),
      OPENCLAW_HOME: path.join(params.root, "home"),
      DISPLAY: ":99",
      XDG_SESSION_TYPE: "x11",
      PATH: `${params.fakeBin}:${process.env.PATH ?? ""}`,
      OPENCLAW_GATEWAY_TOKEN: "synthetic-ambient-token",
      OPENCLAW_GATEWAY_PASSWORD: "synthetic-ambient-password",
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_PORT: "18789",
    },
    timeout: 15_000,
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(["macos", "linux"] as const)("computer-use %s live rig auth", (platform) => {
  async function prepareRig() {
    const fixture = createRigRepository();
    const scratch = path.join(fixture.root, "scratch");
    const profile = "proof-test";
    const port = String(await reservePort());
    const args =
      platform === "macos"
        ? ["prepare", profile, port, fixture.app, scratch]
        : ["prepare-linux", profile, port, scratch];
    const result = runRig({ ...fixture, args });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return { ...fixture, scratch, profile, port, result };
  }

  it("generates matching private token configs for a fresh read-only CLI", async () => {
    const rig = await prepareRig();
    const gatewayPath = path.join(rig.scratch, "gateway.json");
    const clientPath = path.join(rig.scratch, platform === "macos" ? "app.json" : "node.json");
    const gateway = JSON.parse(readFileSync(gatewayPath, "utf8"));
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(gateway.gateway.auth.mode).toBe("token");
    // Boolean comparisons keep generated secrets out of assertion failures.
    const token = gateway.gateway.auth.token;
    expect(typeof token === "string" && /^[a-f0-9]{64}$/.test(token)).toBe(true);
    expect(client.gateway.remote.token === token).toBe(true);
    expect(`${rig.result.stdout}${rig.result.stderr}`.includes(token)).toBe(false);
    expect(readFileSync(path.join(rig.scratch, "rig.json"), "utf8").includes(token)).toBe(false);
    expect(gateway.gateway.mode).toBe("local");
    expect(gateway.gateway.bind).toBe("loopback");
    expect(gateway.gateway.nodes.commands.allow).toEqual(["computer.act"]);
    expect(gateway.gateway.controlUi).toBeUndefined();
    expect(client.gateway.mode).toBe("remote");
    expect(client.gateway.remote.url).toBe(`ws://127.0.0.1:${rig.port}`);
    expect(readdirSync(path.join(rig.scratch, "cli-state"))).toEqual([]);
    const configPaths = [gatewayPath, clientPath];
    if (platform === "macos") {
      const appConfig = path.join(rig.root, "home", `.openclaw-${rig.profile}`, "openclaw.json");
      expect(readFileSync(appConfig, "utf8") === readFileSync(clientPath, "utf8")).toBe(true);
      expect(gateway.gateway.nodes.pairing).toBeUndefined();
      configPaths.push(appConfig);
    } else {
      expect(gateway.gateway.nodes.pairing).toEqual({ autoApproveLocal: true, sshVerify: false });
      expect(client.plugins.entries["cua-computer"].enabled).toBe(true);
    }
    for (const configPath of configPaths) {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
    const other = await prepareRig();
    const otherToken = JSON.parse(readFileSync(path.join(other.scratch, "gateway.json"), "utf8"))
      .gateway.auth.token;
    expect(otherToken === token).toBe(false);
  });

  it("forces token/loopback launch and rejects ambient credential and target precedence", async () => {
    const rig = await prepareRig();
    const gatewayState =
      platform === "macos"
        ? path.join(rig.root, "home", `.openclaw-${rig.profile}`)
        : path.join(rig.scratch, "gateway-state");
    for (const [command, state, extra] of [
      ["gateway", gatewayState, []],
      ["nodes", path.join(rig.scratch, "cli-state"), []],
      ["approve", path.join(rig.scratch, "agent-state"), ["synthetic-request"]],
    ] as const) {
      const result = runRig({ ...rig, args: [command, rig.scratch, ...extra] });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const invocation = JSON.parse(result.stdout);
      expect(invocation.ambient).toEqual([]);
      expect(invocation.config).toBe(path.join(rig.scratch, "gateway.json"));
      expect(invocation.state).toBe(state);
      if (command === "gateway") {
        expect(invocation.args).toEqual([
          "--profile",
          rig.profile,
          "gateway",
          "run",
          "--port",
          rig.port,
          "--auth",
          "token",
          "--bind",
          "loopback",
          "--verbose",
        ]);
      }
    }
    const result = runRig({ ...rig, args: [platform === "macos" ? "app" : "node", rig.scratch] });
    expect(result.status).toBe(0);
    const invocation = JSON.parse(result.stdout);
    expect(invocation.ambient).toEqual([]);
    if (platform === "macos") {
      expect(invocation.profile).toBe(rig.profile);
    } else {
      expect(invocation.config).toBe(path.join(rig.scratch, "node.json"));
      expect(invocation.state).toBe(path.join(rig.scratch, "node-state"));
    }
  });
});

describe("computer-use live rig source integrity", () => {
  it("refuses macOS preparation after the proof runner changes", async () => {
    const fixture = createRigRepository();
    writeFileSync(fixture.proof, "// locally modified proof\n");
    const result = runRig({
      ...fixture,
      args: [
        "prepare",
        "proof-test",
        String(await reservePort()),
        fixture.app,
        path.join(fixture.root, "scratch-mac"),
        "cua",
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime sources are dirty");
  });

  it("refuses Linux preparation after the X11 fixture changes", async () => {
    const fixture = createRigRepository();
    writeFileSync(fixture.fixture, "# locally modified fixture\n");
    const result = runRig({
      ...fixture,
      args: [
        "prepare-linux",
        "proof-test",
        String(await reservePort()),
        path.join(fixture.root, "scratch-linux"),
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime sources are dirty");
  });
});
