// Crestodian rescue-message Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleCrestodianCommand } from "../../dist/auto-reply/reply/commands-crestodian.js";
import { clearConfigCache } from "../../dist/config/config.js";
import type { OpenClawConfig } from "../../dist/config/types.openclaw.js";
import { runCrestodianRescueMessage } from "../../dist/crestodian/rescue-message.js";

type CommandResult = Awaited<ReturnType<typeof handleCrestodianCommand>>;

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
  } as Parameters<typeof handleCrestodianCommand>[0];
}

async function invoke(commandBody: string, cfg: OpenClawConfig, isGroup = false): Promise<string> {
  const result: CommandResult = await handleCrestodianCommand(
    makeParams(commandBody, cfg, isGroup),
    true,
  );
  assert(result, `Command was not handled: ${commandBody}`);
  assert(!result.shouldContinue, `Command should stop normal agent dispatch: ${commandBody}`);
  const text = result.reply?.text;
  assert(typeof text === "string", `Command did not return text: ${commandBody}`);
  return text;
}

async function main() {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-")));
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

  const denied = await invoke("/crestodian status", {
    crestodian: { rescue: { enabled: true } },
    agents: { defaults: { sandbox: { mode: "all" } } },
  });
  assert(denied.includes("sandboxing is active"), "sandboxed rescue was not denied");

  const cfg: OpenClawConfig = {};
  const refusedTui = await invoke("/crestodian talk to agent", cfg);
  assert(
    refusedTui.includes("cannot open the local TUI"),
    "remote rescue TUI handoff was not refused",
  );

  const plan = await invoke("/crestodian set default model openai/gpt-5.2", cfg);
  assert(
    plan.includes("Reply /crestodian yes to apply"),
    "persistent change did not require approval",
  );
  const applied = await invoke("/crestodian yes", cfg);
  assert(applied.includes("Default model: openai/gpt-5.2"), "approved change did not apply");

  const configValid = await invoke("/crestodian validate config", cfg);
  assert(configValid.includes("Config valid:"), "config validation did not report valid config");

  const configSetPlan = await invoke("/crestodian config set gateway.port 19001", cfg);
  assert(
    configSetPlan.includes("Reply /crestodian yes to apply"),
    "generic config set did not require approval",
  );
  const configSetApplied = await invoke("/crestodian yes", cfg);
  assert(configSetApplied.includes("[crestodian] done: config.set"), "generic config set failed");

  const refPlan = await invoke(
    "/crestodian config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN",
    cfg,
  );
  assert(
    refPlan.includes("Reply /crestodian yes to apply"),
    "SecretRef set did not require approval",
  );
  const refApplied = await invoke("/crestodian yes", cfg);
  assert(refApplied.includes("[crestodian] done: config.setRef"), "SecretRef set failed");

  const agentPlan = await invoke("/crestodian create agent work workspace /tmp/openclaw-work", cfg);
  assert(
    agentPlan.includes("Reply /crestodian yes to apply"),
    "agent creation did not require approval",
  );
  const agentApplied = await invoke("/crestodian yes", cfg);
  assert(agentApplied.includes("[crestodian] done: agents.create"), "agent creation did not apply");

  const setupPlan = await invoke(
    "/crestodian setup workspace /tmp/openclaw-setup model openai/gpt-5.2",
    cfg,
  );
  assert(setupPlan.includes("Reply /crestodian yes to apply"), "setup did not require approval");
  const setupApplied = await invoke("/crestodian yes", cfg);
  assert(setupApplied.includes("[crestodian] done: crestodian.setup"), "setup did not apply");

  const gatewayRestarts: string[] = [];
  const gatewayCommand = makeParams("/crestodian restart gateway", cfg).command;
  const gatewayPlan = await runCrestodianRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/crestodian restart gateway",
    agentId: "default",
    isGroup: false,
    deps: {
      runGatewayRestart: async () => {
        gatewayRestarts.push("restart");
      },
    },
  });
  assert(
    gatewayPlan?.includes("Reply /crestodian yes to apply"),
    "gateway restart did not require approval",
  );
  const gatewayApplied = await runCrestodianRescueMessage({
    cfg,
    command: gatewayCommand,
    commandBody: "/crestodian yes",
    agentId: "default",
    isGroup: false,
    deps: {
      runGatewayRestart: async () => {
        gatewayRestarts.push("restart");
      },
    },
  });
  assert(
    gatewayApplied?.includes("[crestodian] done: gateway.restart"),
    "gateway restart did not apply",
  );
  assert(gatewayRestarts.length === 1, "gateway restart dependency was not invoked once");

  const doctorRuns: string[] = [];
  const doctorCommand = makeParams("/crestodian doctor fix", cfg).command;
  const doctorPlan = await runCrestodianRescueMessage({
    cfg,
    command: doctorCommand,
    commandBody: "/crestodian doctor fix",
    agentId: "default",
    isGroup: false,
    deps: {
      runDoctor: async (_runtime, options) => {
        doctorRuns.push(options.repair ? "repair" : "check");
      },
    },
  });
  assert(
    doctorPlan?.includes("Reply /crestodian yes to apply"),
    "doctor fix did not require approval",
  );
  const doctorApplied = await runCrestodianRescueMessage({
    cfg,
    command: doctorCommand,
    commandBody: "/crestodian yes",
    agentId: "default",
    isGroup: false,
    deps: {
      runDoctor: async (_runtime, options) => {
        doctorRuns.push(options.repair ? "repair" : "check");
      },
    },
  });
  assert(doctorApplied?.includes("[crestodian] done: doctor.fix"), "doctor fix did not apply");
  assert(doctorRuns.join(",") === "repair", "doctor repair dependency was not invoked once");

  const updatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    updatedConfig.agents?.defaults?.model &&
      typeof updatedConfig.agents.defaults.model === "object" &&
      "primary" in updatedConfig.agents.defaults.model &&
      updatedConfig.agents.defaults.model.primary === "openai/gpt-5.2",
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
    updatedConfig.agents?.list?.some(
      (agent) => agent.id === "work" && agent.workspace === "/tmp/openclaw-work",
    ),
    "agent config was not updated",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
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
    audits.some((audit) => audit.operation === "crestodian.setup"),
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
  assert(
    audits.some((audit) => audit.operation === "doctor.fix"),
    "doctor fix audit missing",
  );

  console.log("Crestodian rescue Docker E2E passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
