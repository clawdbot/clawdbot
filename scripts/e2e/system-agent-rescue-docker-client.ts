// OpenClaw rescue-message Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import fs from "node:fs/promises";
import path from "node:path";
import { handleSystemAgentCommand } from "../../dist/auto-reply/reply/commands-system-agent.js";
import { clearConfigCache } from "../../dist/config/config.js";
import type { OpenClawConfig } from "../../dist/config/types.openclaw.js";
import { runSystemAgentRescueMessage } from "../../dist/system-agent/rescue-message.js";
import { createE2eStateDir } from "./lib/temp-state-dir.ts";

type CommandResult = Awaited<ReturnType<typeof handleSystemAgentCommand>>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeParams(commandBody: string, cfg: OpenClawConfig, isGroup = false) {
  return {
    cfg,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      accountId: "default",
      ownerList: ["user:owner"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user:owner",
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
      from: "user:owner",
      to: "account:default",
    },
    agentId: "default",
    isGroup,
  } as Parameters<typeof handleSystemAgentCommand>[0];
}

async function invoke(commandBody: string, cfg: OpenClawConfig, isGroup = false): Promise<string> {
  const result: CommandResult = await handleSystemAgentCommand(
    makeParams(commandBody, cfg, isGroup),
    true,
  );
  assert(result, `Command was not handled: ${commandBody}`);
  assert(!result.shouldContinue, `Command should stop normal agent dispatch: ${commandBody}`);
  const text = result.reply?.text;
  assert(typeof text === "string", `Command did not return text: ${commandBody}`);
  return text;
}

async function invokeWithDeps(
  commandBody: string,
  cfg: OpenClawConfig,
  deps: NonNullable<Parameters<typeof runSystemAgentRescueMessage>[0]["deps"]>,
): Promise<string> {
  const result = await runSystemAgentRescueMessage({
    cfg,
    command: makeParams(commandBody, cfg).command,
    commandBody,
    agentId: "default",
    isGroup: false,
    deps,
  });
  assert(typeof result === "string", `Direct rescue command did not return text: ${commandBody}`);
  return result;
}

async function main() {
  const tempState = await createE2eStateDir("openclaw-openclaw-");
  tempState.registerExitCleanup();
  const stateDir = tempState.stateDir;
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        meta: { lastTouchedVersion: "docker-e2e", lastTouchedAt: new Date(0).toISOString() },
        agents: { defaults: {} },
      },
      null,
      2,
    ),
  );
  clearConfigCache();

  const denied = await invoke("/openclaw status", {
    systemAgent: { rescue: { enabled: true } },
    agents: { defaults: { sandbox: { mode: "all" } } },
  });
  assert(denied.includes("sandboxing is active"), "sandboxed rescue was not denied");

  const cfg: OpenClawConfig = {};
  const deterministicInference = {
    verifyInferenceConfig: async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.2",
      latencyMs: 1,
    }),
  };
  const refusedTui = await invoke("/openclaw talk to agent", cfg);
  assert(
    refusedTui.includes("cannot open the local TUI"),
    "remote rescue TUI handoff was not refused",
  );

  // This packaged smoke verifies rescue persistence, not live provider credentials.
  const plan = await invokeWithDeps(
    "/openclaw set default model openai/gpt-5.2",
    cfg,
    deterministicInference,
  );
  assert(
    plan.includes("Reply /openclaw yes to apply"),
    "persistent change did not require approval",
  );
  const applied = await invokeWithDeps("/openclaw yes", cfg, deterministicInference);
  assert(applied.includes("Default model: openai/gpt-5.2"), "approved change did not apply");

  const configValid = await invoke("/openclaw validate config", cfg);
  assert(configValid.includes("Config valid:"), "config validation did not report valid config");

  const configSetPlan = await invoke("/openclaw config set gateway.port 19001", cfg);
  assert(
    configSetPlan.includes("Reply /openclaw yes to apply"),
    "generic config set did not require approval",
  );
  const configSetApplied = await invoke("/openclaw yes", cfg);
  assert(configSetApplied.includes("[openclaw] done: config.set"), "generic config set failed");

  const refPlan = await invoke(
    "/openclaw config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN",
    cfg,
  );
  assert(
    refPlan.includes("Reply /openclaw yes to apply"),
    "SecretRef set did not require approval",
  );
  const refApplied = await invoke("/openclaw yes", cfg);
  assert(refApplied.includes("[openclaw] done: config.setRef"), "SecretRef set failed");

  const agentPlan = await invoke("/openclaw create agent work workspace /tmp/openclaw-work", cfg);
  assert(
    agentPlan.includes("Reply /openclaw yes to apply"),
    "agent creation did not require approval",
  );
  const agentApplied = await invoke("/openclaw yes", cfg);
  assert(agentApplied.includes("[openclaw] done: agents.create"), "agent creation did not apply");

  const setupPlan = await invokeWithDeps(
    "/openclaw setup workspace /tmp/openclaw-setup model openai/gpt-5.2",
    cfg,
    deterministicInference,
  );
  assert(setupPlan.includes("Reply /openclaw yes to apply"), "setup did not require approval");
  const setupApplied = await invokeWithDeps("/openclaw yes", cfg, deterministicInference);
  assert(setupApplied.includes("[openclaw] done: openclaw.setup"), "setup did not apply");

  const gatewayRestarts: string[] = [];
  const gatewayCommand = makeParams("/openclaw restart gateway", cfg).command;
  const gatewayPlan = await runSystemAgentRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/openclaw restart gateway",
    agentId: "default",
    isGroup: false,
    deps: {
      runGatewayRestart: async () => {
        gatewayRestarts.push("restart");
      },
    },
  });
  assert(
    gatewayPlan?.includes("Reply /openclaw yes to apply"),
    "gateway restart did not require approval",
  );
  const pluginList = await runSystemAgentRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/openclaw plugins list",
    agentId: "default",
    isGroup: false,
    deps: {
      runPluginsList: async (runtime) => runtime.log("plugin rows"),
    },
  });
  assert(pluginList === "plugin rows", "read-only rescue command did not run");
  const revokedApproval = await runSystemAgentRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/openclaw yes",
    agentId: "default",
    isGroup: false,
    deps: {
      runGatewayRestart: async () => {
        gatewayRestarts.push("restart");
      },
    },
  });
  assert(
    revokedApproval === "No pending OpenClaw rescue change is waiting for approval.",
    "fresh rescue command did not revoke the older pending change",
  );
  assert(gatewayRestarts.length === 0, "revoked gateway restart was invoked");
  await runSystemAgentRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/openclaw restart gateway",
    agentId: "default",
    isGroup: false,
  });
  const gatewayApplied = await runSystemAgentRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/openclaw yes",
    agentId: "default",
    isGroup: false,
    deps: {
      runGatewayRestart: async () => {
        gatewayRestarts.push("restart");
      },
    },
  });
  assert(
    gatewayApplied?.includes("[openclaw] done: gateway.restart"),
    "gateway restart did not apply",
  );
  assert(gatewayRestarts.length === 1, "gateway restart dependency was not invoked once");

  const doctorRuns: string[] = [];
  const doctorCommand = makeParams("/openclaw doctor fix", cfg).command;
  const doctorReply = await runSystemAgentRescueMessage({
    cfg,
    command: doctorCommand,
    commandBody: "/openclaw doctor fix",
    agentId: "default",
    isGroup: false,
    deps: {
      runDoctor: async (_runtime, options) => {
        doctorRuns.push(options.repair ? "repair" : "check");
      },
    },
  });
  assert(
    doctorReply?.includes("openclaw doctor --fix"),
    "remote doctor fix did not point to the local repair command",
  );
  assert(doctorRuns.length === 0, "remote rescue must not invoke doctor repair");

  const updatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const updatedModel = updatedConfig.agents?.defaults?.model;
  assert(
    (typeof updatedModel === "string" ? updatedModel : updatedModel?.primary) === "openai/gpt-5.2",
    "config default model was not updated",
  );
  assert(updatedConfig.gateway?.port === 19001, "generic config set did not update gateway.port");
  assert(
    updatedConfig.gateway?.auth?.token &&
      typeof updatedConfig.gateway.auth.token === "object" &&
      "id" in updatedConfig.gateway.auth.token &&
      updatedConfig.gateway.auth.token.id === "OPENCLAW_GATEWAY_TOKEN",
    "SecretRef set did not update gateway.auth.token",
  );
  assert(
    updatedConfig.agents?.defaults?.workspace === "/tmp/openclaw-setup",
    "setup did not update default workspace",
  );
  assert(
    updatedConfig.agents?.entries?.work?.workspace === "/tmp/openclaw-work",
    "agent config was not updated",
  );

  const auditPath = path.join(stateDir, "audit", "system-agent.jsonl");
  const auditLines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
  assert(auditLines.length >= 2, "audit log did not record both operations");
  const audits = auditLines.map((line) => JSON.parse(line));
  assert(
    audits.some((audit) => audit.operation === "config.setDefaultModel"),
    "model audit operation missing",
  );
  assert(
    audits.some((audit) => audit.operation === "config.set"),
    "config set audit missing",
  );
  assert(
    audits.some((audit) => audit.operation === "config.setRef"),
    "SecretRef config audit missing",
  );
  assert(
    audits.some((audit) => audit.operation === "openclaw.setup"),
    "setup audit missing",
  );
  const agentAudit = audits.find((audit) => audit.operation === "agents.create");
  assert(agentAudit, "agent audit operation missing");
  assert(agentAudit.details?.rescue === true, "audit rescue marker missing");
  assert(agentAudit.details?.channel === "whatsapp", "audit channel missing");
  assert(agentAudit.details?.senderId === "user:owner", "audit sender missing");
  assert(agentAudit.details?.agentId === "work", "audit agent missing");
  assert(
    audits.some((audit) => audit.operation === "gateway.restart"),
    "gateway restart audit operation missing",
  );

  console.log("OpenClaw rescue Docker E2E passed");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
