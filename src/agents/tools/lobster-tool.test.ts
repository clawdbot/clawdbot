import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLobsterTool } from "./lobster-tool.js";

async function writeFakeLobster(params: {
  script: (args: string[]) => unknown;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-lobster-"));
  const binPath = path.join(dir, "lobster");

  const file = `#!/usr/bin/env node\n` +
    `const args = process.argv.slice(2);\n` +
    `const payload = (${params.script.toString()})(args);\n` +
    `process.stdout.write(JSON.stringify(payload));\n`;

  await fs.writeFile(binPath, file, { encoding: "utf8", mode: 0o755 });
  return { dir, binPath };
}

describe("lobster tool", () => {
  it("runs lobster in tool mode and returns envelope", async () => {
    const fake = await writeFakeLobster({
      script: (args) => {
        if (args[0] !== "run") throw new Error("expected run");
        return {
          ok: true,
          status: "ok",
          output: [{ hello: "world" }],
          requiresApproval: null,
        };
      },
    });

    const tool = createLobsterTool();
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "exec --json \"echo [1]\"",
      lobsterPath: fake.binPath,
      timeoutMs: 1000,
    });

    expect(res.details).toMatchObject({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("supports resume action", async () => {
    const fake = await writeFakeLobster({
      script: (args) => {
        if (args[0] !== "resume") throw new Error("expected resume");
        return {
          ok: true,
          status: "ok",
          output: ["resumed"],
          requiresApproval: null,
        };
      },
    });

    const tool = createLobsterTool();
    const res = await tool.execute("call2", {
      action: "resume",
      token: "tok",
      approve: true,
      lobsterPath: fake.binPath,
      timeoutMs: 1000,
    });

    expect(res.details).toMatchObject({ ok: true, status: "ok" });
  });

  it("rejects non-absolute lobsterPath", async () => {
    const tool = createLobsterTool();
    await expect(
      tool.execute("call3", {
        action: "run",
        pipeline: "json",
        lobsterPath: "./lobster",
      }),
    ).rejects.toThrow(/absolute path/);
  });

  it("blocks tool in sandboxed mode", async () => {
    const tool = createLobsterTool({ sandboxed: true });
    await expect(
      tool.execute("call4", {
        action: "run",
        pipeline: "json",
        lobsterPath: "/usr/bin/true",
      }),
    ).rejects.toThrow(/not available in sandboxed/);
  });

  it("rejects invalid JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-lobster-bad-"));
    const binPath = path.join(dir, "lobster");
    await fs.writeFile(
      binPath,
      `#!/usr/bin/env node\nprocess.stdout.write('not-json');\n`,
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );

    const tool = createLobsterTool();
    await expect(
      tool.execute("call5", {
        action: "run",
        pipeline: "json",
        lobsterPath: binPath,
      }),
    ).rejects.toThrow(/invalid JSON/);
  });
});
