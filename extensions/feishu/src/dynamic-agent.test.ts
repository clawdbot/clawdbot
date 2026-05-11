import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-agent-"));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

function createRuntime() {
  const replaceConfigFile = vi.fn(async () => {});
  return {
    runtime: {
      config: {
        replaceConfigFile,
      },
    } as unknown as PluginRuntime,
    replaceConfigFile,
  };
}

function createDynamicConfig() {
  return {
    enabled: true,
    workspaceTemplate: path.join(tempRoot, "workspace-{agentId}"),
    agentDirTemplate: path.join(tempRoot, "agent-{agentId}"),
  };
}

async function pathExists(target: string): Promise<boolean> {
  return fs.promises
    .stat(target)
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    });
}

describe("maybeCreateDynamicAgent", () => {
  it("does not persist dynamic agents when config writes are disabled", async () => {
    const { runtime, replaceConfigFile } = createRuntime();
    const dynamicCfg = createDynamicConfig();

    const result = await maybeCreateDynamicAgent({
      cfg: {
        channels: { feishu: { configWrites: false } },
        agents: { list: [] },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg,
      configWritesAllowed: false,
      log: vi.fn(),
    });

    expect(result).toEqual({
      created: false,
      updatedCfg: {
        channels: { feishu: { configWrites: false } },
        agents: { list: [] },
        bindings: [],
      },
    });
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(false);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(false);
  });

  it("persists a sender agent and direct binding when config writes are allowed", async () => {
    const { runtime, replaceConfigFile } = createRuntime();

    const result = await maybeCreateDynamicAgent({
      cfg: {
        agents: { list: [] },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: createDynamicConfig(),
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("feishu-ou_sender");
    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        agents: {
          list: [
            {
              id: "feishu-ou_sender",
              workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
              agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
            },
          ],
        },
        bindings: [
          {
            agentId: "feishu-ou_sender",
            match: {
              channel: "feishu",
              peer: { kind: "direct", id: "ou_sender" },
            },
          },
        ],
      },
      afterWrite: { mode: "auto" },
    });
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(true);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(true);
  });

  it("keeps the maxAgents limit before adding a missing binding", async () => {
    const { runtime, replaceConfigFile } = createRuntime();

    const result = await maybeCreateDynamicAgent({
      cfg: {
        agents: {
          list: [
            {
              id: "feishu-ou_sender",
              workspace: path.join(tempRoot, "existing-workspace"),
              agentDir: path.join(tempRoot, "existing-agent"),
            },
          ],
        },
        bindings: [],
      } as OpenClawConfig,
      runtime,
      senderOpenId: "ou_sender",
      dynamicCfg: {
        ...createDynamicConfig(),
        maxAgents: 1,
      },
      configWritesAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });
});
