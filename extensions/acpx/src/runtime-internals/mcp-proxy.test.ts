// ACPX tests cover mcp proxy plugin behavior.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const proxyPath = path.resolve(bundledPluginFile("acpx", "src/runtime-internals/mcp-proxy.mjs"));

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function makeTempScript(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-mcp-proxy-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("mcp-proxy", () => {
  it("hides the target MCP process window on Windows only", async () => {
    const moduleUrl = pathToFileURL(proxyPath).href;
    const { createTargetSpawnOptions } = (await import(moduleUrl)) as {
      createTargetSpawnOptions: (platform?: NodeJS.Platform) => Record<string, unknown>;
    };

    expect(createTargetSpawnOptions("win32")).toEqual({
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    expect(createTargetSpawnOptions("darwin")).not.toHaveProperty("windowsHide");
    expect(createTargetSpawnOptions("linux")).not.toHaveProperty("windowsHide");
    // Off Windows the target owns its process group so teardown can reap the
    // whole tree, descendants included.
    expect(createTargetSpawnOptions("darwin")).toHaveProperty("detached", true);
    expect(createTargetSpawnOptions("linux")).toHaveProperty("detached", true);
  });

  it("terminates the whole target tree on Windows via taskkill /T", async () => {
    const moduleUrl = pathToFileURL(proxyPath).href;
    const { createWindowsTreeKillCommand } = (await import(moduleUrl)) as {
      createWindowsTreeKillCommand: (
        pid: number,
        signal: string,
      ) => { command: string; args: string[] };
    };

    // No POSIX group signaling on Windows: taskkill /T walks the tree from
    // the target pid so descendants are terminated together with it.
    expect(createWindowsTreeKillCommand(1234, "SIGTERM")).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T"],
    });
    // The forced phase adds /F, the SIGKILL equivalent for a resistant tree.
    expect(createWindowsTreeKillCommand(1234, "SIGKILL")).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T", "/F"],
    });
  });

  it("injects configured MCP servers into ACP session bootstrap requests", async () => {
    const echoServerPath = await makeTempScript(
      "echo-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => process.stdout.write(line + "\n"));
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${echoServerPath}`,
      mcpServers: [
        {
          name: "canva",
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: [{ name: "CANVA_TOKEN", value: "secret" }],
        },
      ],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: { cwd: process.cwd(), sessionId: "sid-1", mcpServers: [] },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: "sid-1", prompt: [{ type: "text", text: "hello" }] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });

    const initialize = expectDefined(lines[0], "MCP initialize message");
    const initialized = expectDefined(lines[1], "MCP initialized message");
    const prompt = expectDefined(lines[2], "MCP prompt message");

    expect(initialize.params.mcpServers).toEqual([
      {
        name: "canva",
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        env: [{ name: "CANVA_TOKEN", value: "secret" }],
      },
    ]);
    expect(initialized.params.mcpServers).toEqual(initialize.params.mcpServers);
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params.mcpServers).toBeUndefined();
  });

  it("kills a target that ignores forwarded stdin EOF after the host disconnects", async () => {
    const hungServerPath = await makeTempScript(
      "hung-server.cjs",
      String.raw`#!/usr/bin/env node
process.stdout.write("ready " + process.pid + "\n");
setTimeout(() => {}, 300_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${hungServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    const targetPid = await new Promise<number>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/ready (\d+)\n/);
        if (match) {
          resolve(Number(match[1]));
        }
      });
    });

    // Host disconnects: closing proxy stdin forwards EOF to the target.
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        try {
          process.kill(targetPid, "SIGKILL");
        } catch {
          // target already gone
        }
        reject(new Error("proxy did not exit after host stdin EOF (target leak)"));
      }, 6_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    // The grace-period kill must reap the stdin-ignoring target too.
    expect(() => process.kill(targetPid, 0)).toThrow();
  }, 15_000);

  it("force-kills a SIGTERM-resistant target after the host disconnects", async () => {
    const termResistantPath = await makeTempScript(
      "term-resistant-server.cjs",
      String.raw`#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write("ready " + process.pid + "\n");
setTimeout(() => {}, 300_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${termResistantPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    const targetPid = await new Promise<number>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/ready (\d+)\n/);
        if (match) {
          resolve(Number(match[1]));
        }
      });
    });

    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        try {
          process.kill(targetPid, "SIGKILL");
        } catch {
          // target already gone
        }
        reject(new Error("proxy did not exit after host stdin EOF (TERM-resistant target leak)"));
      }, 8_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    // SIGTERM was ignored, so the bounded SIGKILL escalation must reap it.
    expect(() => process.kill(targetPid, 0)).toThrow();
  }, 15_000);

  it("reaps a target descendant after the host disconnects", async () => {
    const parentServerPath = await makeTempScript(
      "parent-server.cjs",
      String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
process.stdout.write("ready " + process.pid + " " + grandchild.pid + "\n");
setTimeout(() => {}, 300_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${parentServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    const pids = await new Promise<{ targetPid: number; grandchildPid: number }>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/ready (\d+) (\d+)\n/);
        if (match) {
          resolve({ targetPid: Number(match[1]), grandchildPid: Number(match[2]) });
        }
      });
    });

    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        for (const pid of [pids.targetPid, pids.grandchildPid]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        reject(new Error("proxy did not exit after host stdin EOF (descendant leak)"));
      }, 8_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    // The descendant stays in the target's process group, so the tree signal
    // must reap it together with the direct target.
    expect(() => process.kill(pids.targetPid, 0)).toThrow();
    expect(() => process.kill(pids.grandchildPid, 0)).toThrow();
  }, 15_000);

  it("reaps target descendants when the target exits cooperatively on EOF", async () => {
    const cooperativeParentPath = await makeTempScript(
      "cooperative-parent-server.cjs",
      String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
process.stdout.write("ready " + process.pid + " " + grandchild.pid + "\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${cooperativeParentPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    const pids = await new Promise<{ targetPid: number; grandchildPid: number }>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/ready (\d+) (\d+)\n/);
        if (match) {
          resolve({ targetPid: Number(match[1]), grandchildPid: Number(match[2]) });
        }
      });
    });

    // Host disconnects; the target handles the forwarded EOF by exiting
    // cleanly, but its background descendant stays behind in the process group.
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        for (const pid of [pids.targetPid, pids.grandchildPid]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        reject(new Error("proxy did not exit after cooperative target exit (descendant leak)"));
      }, 8_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    // EOF teardown must keep tree ownership past the cooperative parent exit
    // and reap the surviving descendant instead of exiting with the parent.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 2_000;
    while ((alive(pids.targetPid) || alive(pids.grandchildPid)) && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    const targetReaped = !alive(pids.targetPid);
    const grandchildReaped = !alive(pids.grandchildPid);
    for (const pid of [pids.targetPid, pids.grandchildPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    expect(targetReaped).toBe(true);
    expect(grandchildReaped).toBe(true);
  }, 15_000);

  it.runIf(process.platform === "win32")(
    "reaps the target tree on Windows after the host disconnects",
    async () => {
      const parentServerPath = await makeTempScript(
        "windows-parent-server.cjs",
        String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
process.stdout.write("ready " + process.pid + " " + grandchild.pid + "\n");
setTimeout(() => {}, 300_000);
`,
      );

      const payload = encodePayload({
        targetCommand: `${process.execPath} ${parentServerPath}`,
        mcpServers: [],
      });

      const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
        stdio: ["pipe", "pipe", "inherit"],
        cwd: process.cwd(),
      });

      let stdout = "";
      const pids = await new Promise<{ targetPid: number; grandchildPid: number }>((resolve) => {
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          const match = stdout.match(/ready (\d+) (\d+)\n/);
          if (match) {
            resolve({ targetPid: Number(match[1]), grandchildPid: Number(match[2]) });
          }
        });
      });

      child.stdin.end();

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("proxy did not exit after host stdin EOF on Windows"));
        }, 12_000);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      expect(exitCode).toBe(0);
      // taskkill /T must terminate the descendant together with the target.
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 5_000;
      while ((alive(pids.targetPid) || alive(pids.grandchildPid)) && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      const targetReaped = !alive(pids.targetPid);
      const grandchildReaped = !alive(pids.grandchildPid);
      for (const pid of [pids.targetPid, pids.grandchildPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      expect(targetReaped).toBe(true);
      expect(grandchildReaped).toBe(true);
    },
    30_000,
  );

  it("forwards a host SIGTERM to the detached target tree", async () => {
    const parentServerPath = await makeTempScript(
      "signal-parent-server.cjs",
      String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
process.stdout.write("ready " + process.pid + " " + grandchild.pid + "\n");
setTimeout(() => {}, 300_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${parentServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    const pids = await new Promise<{ targetPid: number; grandchildPid: number }>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/ready (\d+) (\d+)\n/);
        if (match) {
          resolve({ targetPid: Number(match[1]), grandchildPid: Number(match[2]) });
        }
      });
    });

    // The host terminates the proxy directly instead of closing stdin; the
    // proxy must forward the signal to the detached target tree before dying.
    child.kill("SIGTERM");

    const exitSignal = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        for (const pid of [pids.targetPid, pids.grandchildPid]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        reject(new Error("proxy did not exit after host SIGTERM"));
      }, 6_000);
      child.once("close", (_code, signal) => {
        clearTimeout(timer);
        resolve(signal);
      });
    });

    expect(exitSignal).toBe("SIGTERM");
    // The tree signal is sent just before the proxy dies, so give the target
    // and its descendant a short window to actually exit.
    const deadline = Date.now() + 2_000;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while ((alive(pids.targetPid) || alive(pids.grandchildPid)) && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    expect(alive(pids.targetPid)).toBe(false);
    expect(alive(pids.grandchildPid)).toBe(false);
  }, 15_000);

  it("reports target stdin pipe failures without an unhandled stream error", async () => {
    const closedStdinServerPath = await makeTempScript(
      "closed-stdin-server.cjs",
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.closeSync(0);
process.stdout.write("ready\n");
setTimeout(() => {}, 30_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${closedStdinServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("ready\n")) {
          resolve();
        }
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    await ready;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/EPIPE|write/i);
    expect(stderr).not.toContain("Unhandled 'error' event");
  });

  it("reports proxy stdout pipe failures without an unhandled stream error", async () => {
    const outputServerPath = await makeTempScript(
      "output-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
process.stderr.write("ready\n");
createInterface({ input: process.stdin }).once("line", () => {
  process.stdout.write("x".repeat(1024 * 1024));
});
setTimeout(() => {}, 30_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${outputServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("ready\n")) {
          resolve();
        }
      });
    });

    await ready;
    child.stdout.destroy();
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/EPIPE|write/i);
    expect(stderr).not.toContain("Unhandled 'error' event");
  });
});
