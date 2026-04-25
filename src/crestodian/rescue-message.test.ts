import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractCrestodianRescueMessage, runCrestodianRescueMessage } from "./rescue-message.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;

function commandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: ["user:owner"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "user:owner",
    rawBodyNormalized: "/crestodian models",
    commandBodyNormalized: "/crestodian models",
    from: "user:owner",
    to: "account:default",
    ...overrides,
  };
}

async function runRescue(
  commandBody: string,
  cfg: OpenClawConfig,
  ctx = commandContext(),
  deps?: Parameters<typeof runCrestodianRescueMessage>[0]["deps"],
) {
  return await runCrestodianRescueMessage({
    cfg,
    command: { ...ctx, commandBodyNormalized: commandBody },
    commandBody,
    isGroup: false,
    deps,
  });
}

describe("Crestodian rescue message", () => {
  afterEach(() => {
    clearConfigCache();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
  });

  it("recognizes the Crestodian rescue command", () => {
    expect(extractCrestodianRescueMessage("/crestodian status")).toBe("status");
    expect(extractCrestodianRescueMessage("/crestodian")).toBe("");
    expect(extractCrestodianRescueMessage("/status")).toBeNull();
  });

  it("denies rescue when sandboxing is active", async () => {
    await expect(
      runRescue("/crestodian status", {
        crestodian: { rescue: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      }),
    ).resolves.toContain("sandboxing is active");
  });

  it("refuses TUI handoff from remote rescue", async () => {
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = {
      runTui: vi.fn(async () => {
        throw new Error("remote rescue must not open the TUI");
      }),
    };

    await expect(
      runRescue("/crestodian talk to agent", cfg, commandContext(), deps),
    ).resolves.toContain("cannot open the local TUI");
    await expect(runRescue("/crestodian chat", cfg, commandContext(), deps)).resolves.toContain(
      "cannot open the local TUI",
    );
    expect(deps.runTui).not.toHaveBeenCalled();
  });

  it("queues and applies persistent writes through conversational approval", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-rescue-"));
    const configPath = path.join(tempDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          meta: { lastTouchedVersion: "test", lastTouchedAt: new Date(0).toISOString() },
          agents: { defaults: {} },
        },
        null,
        2,
      ),
    );

    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    await expect(runRescue("/crestodian set default model openai/gpt-5.2", cfg)).resolves.toContain(
      "Reply /crestodian yes to apply",
    );
    await expect(runRescue("/crestodian yes", cfg)).resolves.toContain(
      "Default model: openai/gpt-5.2",
    );

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(config.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-5.2" });
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit.details).toMatchObject({
      rescue: true,
      channel: "whatsapp",
      senderId: "user:owner",
    });
  });

  it("queues and applies gateway restart through conversational approval", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-rescue-gateway-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = { runGatewayRestart: vi.fn(async () => {}) };

    await expect(
      runRescue("/crestodian restart gateway", cfg, commandContext(), deps),
    ).resolves.toBe("Plan: restart the Gateway. Reply /crestodian yes to apply.");
    await expect(runRescue("/crestodian yes", cfg, commandContext(), deps)).resolves.toContain(
      "[crestodian] done: gateway.restart",
    );

    expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "gateway.restart",
      details: {
        rescue: true,
        channel: "whatsapp",
        senderId: "user:owner",
      },
    });
  });

  it("queues and applies agent creation through conversational approval", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-rescue-agent-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = { runAgentsAdd: vi.fn(async () => {}) };

    await expect(
      runRescue("/crestodian create agent work workspace /tmp/work", cfg, commandContext(), deps),
    ).resolves.toBe(
      "Plan: create agent work with workspace /tmp/work. Reply /crestodian yes to apply.",
    );
    await expect(runRescue("/crestodian yes", cfg, commandContext(), deps)).resolves.toContain(
      "[crestodian] done: agents.create",
    );

    expect(deps.runAgentsAdd).toHaveBeenCalledTimes(1);
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "agents.create",
      details: {
        rescue: true,
        channel: "whatsapp",
        senderId: "user:owner",
        agentId: "work",
        workspace: "/tmp/work",
      },
    });
  });
});
