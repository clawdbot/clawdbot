import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as {
        stdout?: Readable;
        stderr?: Readable;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });

      const dockerArgs = command === "docker" ? args : [];
      const shouldFailContainerInspect =
        dockerArgs[0] === "inspect" &&
        dockerArgs[1] === "-f" &&
        dockerArgs[2] === "{{.State.Running}}";
      const shouldSucceedImageInspect = dockerArgs[0] === "image" && dockerArgs[1] === "inspect";

      const code = shouldFailContainerInspect ? 1 : 0;
      if (shouldSucceedImageInspect) {
        queueMicrotask(() => child.emit("close", 0));
      } else {
        queueMicrotask(() => child.emit("close", code));
      }
      return child;
    },
  };
});

async function writeSkill(params: { dir: string; name: string; description: string }) {
  const { dir, name, description } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("sandbox skill mirroring", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    spawnCalls.length = 0;
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.resetModules();
  });

  const runContext = async (workspaceAccess: "none" | "ro") => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-state-"));
    const bundledDir = path.join(stateDir, "bundled-skills");
    await fs.mkdir(bundledDir, { recursive: true });

    process.env.CLAWDBOT_STATE_DIR = stateDir;
    process.env.CLAWDBOT_BUNDLED_SKILLS_DIR = bundledDir;
    vi.resetModules();

    const { resolveSandboxContext } = await import("./sandbox.js");

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-workspace-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Demo skill",
    });

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess,
            workspaceRoot: path.join(stateDir, "sandboxes"),
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    return { context, workspaceDir };
  };

  it("copies skills into the sandbox when workspaceAccess is ro", async () => {
    const { context } = await runContext("ro");

    expect(context?.enabled).toBe(true);
    const skillPath = path.join(context?.workspaceDir ?? "", "skills", "demo-skill", "SKILL.md");
    await expect(fs.readFile(skillPath, "utf-8")).resolves.toContain("demo-skill");
  }, 20_000);

  it("copies skills into the sandbox when workspaceAccess is none", async () => {
    const { context } = await runContext("none");

    expect(context?.enabled).toBe(true);
    const skillPath = path.join(context?.workspaceDir ?? "", "skills", "demo-skill", "SKILL.md");
    await expect(fs.readFile(skillPath, "utf-8")).resolves.toContain("demo-skill");
  }, 20_000);
});
