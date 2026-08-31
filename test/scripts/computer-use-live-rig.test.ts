import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(proof, "// committed proof\n");
  writeExecutable(appExecutable, "#!/bin/sh\nexit 0\n");
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
      ...process.env,
      DISPLAY: ":99",
      WAYLAND_DISPLAY: "",
      XDG_SESSION_TYPE: "x11",
      PATH: `${params.fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
