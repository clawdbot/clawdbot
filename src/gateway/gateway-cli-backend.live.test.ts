import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliBackendConfig, resolveCliBackendLiveTest } from "../agents/cli-backends.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  applyCliBackendLiveEnv,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
  matchesCliBackendReply,
  parseImageMode,
  resolveCliModelSwitchProbeTarget,
  resolveCliBackendLiveArgs,
  parseJsonStringArray,
  restoreCliBackendLiveEnv,
  shouldRunCliImageProbe,
  shouldRunCliModelSwitchProbe,
  shouldRunCliMcpProbe,
  snapshotCliBackendLiveEnv,
  type SystemPromptReport,
  verifyCliCronMcpLoopbackPreflight,
  verifyCliCronMcpProbe,
  verifyCliBackendImageProbe,
  withClaudeMcpConfigOverrides,
  connectTestGatewayClient,
} from "./gateway-cli-backend.live-helpers.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CLI_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const CLI_RESUME = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE);
const CLI_DEBUG = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG);
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const DEFAULT_PROVIDER = "claude-cli";
const DEFAULT_MODEL =
  resolveCliBackendLiveTest(DEFAULT_PROVIDER)?.defaultModelRef ?? "claude-cli/claude-sonnet-4-6";
// The cron/MCP live probe now tolerates more cancelled tool-call retries in CI,
// so the outer test budget needs enough headroom to finish those retries.
const CLI_BACKEND_LIVE_TIMEOUT_MS = 720_000;

function logCliBackendLiveStep(step: string, details?: Record<string, unknown>): void {
  if (!CLI_DEBUG) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-cli-live] ${step}${suffix}`);
}

describeLive("gateway live (cli backend)", () => {
  it(
    "runs the agent pipeline against the local CLI backend",
    async () => {
      const preservedEnv = new Set(
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV,
        ) ?? [],
      );
      const previousEnv = snapshotCliBackendLiveEnv();

      clearRuntimeConfigSnapshot();
      applyCliBackendLiveEnv(preservedEnv);

      const token = `test-${randomUUID()}`;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      const port = await getFreeGatewayPort();
      logCliBackendLiveStep("env-ready", { port });

      const rawModel = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
      const parsed = parseModelRef(rawModel, "claude-cli");
      if (!parsed) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_MODEL must resolve to a CLI backend model. Got: ${rawModel}`,
        );
      }

      const providerId = parsed.provider;
      const modelKey = `${providerId}/${parsed.model}`;
      const backendResolved = resolveCliBackendConfig(providerId);
      const enableCliImageProbe = shouldRunCliImageProbe(providerId);
      const enableCliMcpProbe = shouldRunCliMcpProbe(providerId);
      const enableCliModelSwitchProbe = shouldRunCliModelSwitchProbe(providerId, modelKey);
      const modelSwitchTarget = enableCliModelSwitchProbe
        ? resolveCliModelSwitchProbeTarget(providerId, modelKey)
        : undefined;
      logCliBackendLiveStep("model-selected", {
        providerId,
        modelKey,
        enableCliImageProbe,
        enableCliMcpProbe,
        enableCliModelSwitchProbe,
        modelSwitchTarget,
      });
      const providerDefaults = backendResolved?.config;

      const cliCommand = process.env.OPENCLAW_LIVE_CLI_BACKEND_COMMAND ?? providerDefaults?.command;
      if (!cliCommand) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_COMMAND is required for provider "${providerId}".`,
        );
      }

      const { args: baseCliArgs, resumeArgs: baseCliResumeArgs } = resolveCliBackendLiveArgs({
        providerId,
        defaultArgs: providerDefaults?.args,
        defaultResumeArgs: providerDefaults?.resumeArgs,
      });

      const cliClearEnv =
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV,
        ) ??
        providerDefaults?.clearEnv ??
        [];
      const filteredCliClearEnv = cliClearEnv.filter((name) => !preservedEnv.has(name));
      const preservedCliEnv = Object.fromEntries(
        [...preservedEnv]
          .map((name) => [name, process.env[name]])
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const cliImageArg =
        process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG?.trim() || providerDefaults?.imageArg;
      const cliImageMode =
        parseImageMode(process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE) ??
        providerDefaults?.imageMode;
      if (cliImageMode && !cliImageArg) {
        throw new Error(
          "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE requires OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG.",
        );
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-"));
      const stateDir = path.join(tempDir, "state");
      await fs.mkdir(stateDir, { recursive: true });
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const bundleMcp = backendResolved?.bundleMcp === true;
      const bootstrapWorkspace =
        backendResolved?.bundleMcpMode === "claude-config-file"
          ? await createBootstrapWorkspace(tempDir)
          : null;
      const disableMcpConfig = process.env.OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG !== "0";
      let cliArgs = baseCliArgs;
      if (
        bundleMcp &&
        disableMcpConfig &&
        backendResolved?.bundleMcpMode === "claude-config-file"
      ) {
        const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
        await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
        cliArgs = withClaudeMcpConfigOverrides(baseCliArgs, mcpConfigPath);
      }

      const cfg: OpenClawConfig = {};
      const cfgWithCliBackends = cfg as OpenClawConfig & {
        agents?: {
          defaults?: {
            cliBackends?: Record<string, Record<string, unknown>>;
          };
        };
      };
      const existingBackends = cfgWithCliBackends.agents?.defaults?.cliBackends ?? {};
      const nextCfg = {
        ...cfg,
        gateway: {
          mode: "local",
          ...cfg.gateway,
          port,
          auth: { mode: "token", token },
        },
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            ...(bootstrapWorkspace ? { workspace: bootstrapWorkspace.workspaceRootDir } : {}),
            model: { primary: modelKey },
            models: {
              [modelKey]: {},
              ...(modelSwitchTarget ? { [modelSwitchTarget]: {} } : {}),
            },
            cliBackends: {
              ...existingBackends,
              [providerId]: {
                command: cliCommand,
                args: cliArgs,
                resumeArgs: baseCliResumeArgs,
                clearEnv: filteredCliClearEnv.length > 0 ? filteredCliClearEnv : undefined,
                env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
                systemPromptWhen: providerDefaults?.systemPromptWhen ?? "never",
                ...(cliImageArg ? { imageArg: cliImageArg, imageMode: cliImageMode } : {}),
              },
            },
            sandbox: { mode: "off" },
          },
        },
      };
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      logCliBackendLiveStep("config-written", {
        tempConfigPath,
        stateDir,
        cliCommand,
        cliArgs,
      });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      logCliBackendLiveStep("server-started");
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        deviceIdentity,
      });
      logCliBackendLiveStep("client-connected");

      try {
        const sessionKey = "agent:dev:live-cli-backend";
        const nonce = randomBytes(3).toString("hex").toUpperCase();
        const memoryNonce = randomBytes(3).toString("hex").toUpperCase();
        const memoryToken = `CLI-MEM-${memoryNonce}`;
        logCliBackendLiveStep("agent-request:start", { sessionKey, nonce });
        const payload = await client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${randomUUID()}`,
            message:
              providerId === "codex-cli"
                ? `Please include the token CLI-BACKEND-${nonce} in your reply.`
                : enableCliModelSwitchProbe
                  ? `Reply with exactly: CLI backend OK ${nonce}.` +
                    ` Also remember this session note for later: ${memoryToken}.` +
                    " Do not include the note in your reply."
                  : `Reply with exactly: CLI backend OK ${nonce}.`,
            deliver: false,
          },
          { expectFinal: true },
        );
        if (payload?.status !== "ok") {
          throw new Error(`agent status=${String(payload?.status)}`);
        }
        logCliBackendLiveStep("agent-request:done", { status: payload?.status });

        const text = extractPayloadText(payload?.result);
        if (providerId === "codex-cli") {
          expect(text).toContain(`CLI-BACKEND-${nonce}`);
        } else {
          const resultWithMeta = payload?.result as {
            meta?: { systemPromptReport?: SystemPromptReport };
          };
          expect(matchesCliBackendReply(text, `CLI backend OK ${nonce}.`)).toBe(true);
          expect(
            resultWithMeta.meta?.systemPromptReport?.injectedWorkspaceFiles?.map(
              (entry) => entry.name,
            ) ?? [],
          ).toEqual(expect.arrayContaining(bootstrapWorkspace?.expectedInjectedFiles ?? []));
        }

        if (modelSwitchTarget) {
          const switchNonce = randomBytes(3).toString("hex").toUpperCase();
          logCliBackendLiveStep("agent-switch:start", {
            sessionKey,
            fromModel: modelKey,
            toModel: modelSwitchTarget,
            switchNonce,
            memoryToken,
          });
          const patchPayload = await client.request("sessions.patch", {
            key: sessionKey,
            model: modelSwitchTarget,
          });
          if (!patchPayload || typeof patchPayload !== "object" || !("ok" in patchPayload)) {
            throw new Error(
              `sessions.patch failed for model switch: ${JSON.stringify(patchPayload)}`,
            );
          }
          const switchPayload = await client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${randomUUID()}`,
              message:
                "We just switched from Claude Sonnet to Claude Opus in the same session. " +
                `What session note did I ask you to remember earlier? ` +
                `Reply with exactly: CLI backend SWITCH OK ${switchNonce} <remembered-note>.`,
              deliver: false,
            },
            { expectFinal: true },
          );
          if (switchPayload?.status !== "ok") {
            throw new Error(`switch status=${String(switchPayload?.status)}`);
          }
          logCliBackendLiveStep("agent-switch:done", { status: switchPayload?.status });
          const switchText = extractPayloadText(switchPayload?.result);
          expect(
            matchesCliBackendReply(
              switchText,
              `CLI backend SWITCH OK ${switchNonce} ${memoryToken}.`,
            ),
          ).toBe(true);
        } else if (CLI_RESUME) {
          const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
          logCliBackendLiveStep("agent-resume:start", { sessionKey, resumeNonce });
          const resumePayload = await client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${randomUUID()}`,
              message:
                providerId === "codex-cli"
                  ? `Please include the token CLI-RESUME-${resumeNonce} in your reply.`
                  : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`,
              deliver: false,
            },
            { expectFinal: true },
          );
          if (resumePayload?.status !== "ok") {
            throw new Error(`resume status=${String(resumePayload?.status)}`);
          }
          logCliBackendLiveStep("agent-resume:done", { status: resumePayload?.status });
          const resumeText = extractPayloadText(resumePayload?.result);
          if (providerId === "codex-cli") {
            expect(resumeText).toContain(`CLI-RESUME-${resumeNonce}`);
          } else {
            expect(
              matchesCliBackendReply(resumeText, `CLI backend RESUME OK ${resumeNonce}.`),
            ).toBe(true);
          }
        }

        if (enableCliImageProbe) {
          logCliBackendLiveStep("image-probe:start", { sessionKey });
          await verifyCliBackendImageProbe({
            client,
            providerId,
            sessionKey,
            tempDir,
            bootstrapWorkspace,
          });
          logCliBackendLiveStep("image-probe:done");
        }

        if (enableCliMcpProbe) {
          logCliBackendLiveStep("cron-mcp-loopback-preflight:start", {
            sessionKey,
            senderIsOwner: true,
          });
          await verifyCliCronMcpLoopbackPreflight({
            sessionKey,
            port,
            token,
            env: process.env,
            senderIsOwner: true,
          });
          logCliBackendLiveStep("cron-mcp-loopback-preflight:done");
          logCliBackendLiveStep("cron-mcp-probe:start", { sessionKey });
          await verifyCliCronMcpProbe({
            client,
            providerId,
            sessionKey,
            port,
            token,
            env: process.env,
          });
          logCliBackendLiveStep("cron-mcp-probe:done");
        }
      } finally {
        logCliBackendLiveStep("cleanup:start");
        clearRuntimeConfigSnapshot();
        await client.stopAndWait();
        await server.close();
        await fs.rm(tempDir, { recursive: true, force: true });
        restoreCliBackendLiveEnv(previousEnv);
        logCliBackendLiveStep("cleanup:done");
      }
    },
    CLI_BACKEND_LIVE_TIMEOUT_MS,
  );
});
