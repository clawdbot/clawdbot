import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      emit: (event: string, code: number) => boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      child.emit("close", 0);
    };
    setImmediate(() => {
      stdout.emit("data", "");
      stderr.emit("data", "");
      child.emit("close", 0);
    });
    return child;
  });
  return { spawn };
});

import { spawn as mockedSpawn } from "node:child_process";
import type { MoltbotConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { QmdMemoryManager } from "./qmd-manager.js";

const spawnMock = mockedSpawn as unknown as vi.Mock;

describe("QmdMemoryManager", () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: MoltbotConfig;
  const agentId = "main";

  beforeEach(async () => {
    spawnMock.mockClear();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-"));
    workspaceDir = path.join(tmpRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(stateDir, { recursive: true });
    process.env.MOLTBOT_STATE_DIR = stateDir;
    cfg = {
      agents: {
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as MoltbotConfig;
  });

  afterEach(async () => {
    delete process.env.MOLTBOT_STATE_DIR;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("debounces back-to-back sync calls", async () => {
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) throw new Error("manager missing");

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    // By default we refresh embeddings less frequently than index updates.
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 3);

    await manager.close();
  });
});
