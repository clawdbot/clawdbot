/**
 * gateway-cli-backend.system-prompt-resume.live.test.ts
 *
 * End-to-end behavioral before/after proof for issue #80374. Designed to
 * actually distinguish pre-fix from post-fix code at the model-response level,
 * not just the argv level.
 *
 * Approach:
 *
 *   Turn 1: system prompt instructs the model to append `MARKER_ALPHA`.
 *   Server restart (kills the live claude process).
 *   Config rewritten: system prompt instructs the model to append `MARKER_BRAVO`.
 *   Turn 2: resume the prior session. Assert reply contains `MARKER_BRAVO`.
 *
 *   Pre-fix (systemPromptWhen="first"): on Turn 2 the new claude process is
 *     spawned with `--resume <id>` but WITHOUT `--append-system-prompt-file`.
 *     The model has no way to know `MARKER_BRAVO` exists — it only sees the
 *     resumed conversation where Turn 1's user message was tagged with
 *     `MARKER_ALPHA`. Reply contains `MARKER_ALPHA`, not `MARKER_BRAVO`.
 *     ASSERTION FAILS.
 *
 *   Post-fix (systemPromptWhen="always"): Turn 2's claude process IS spawned
 *     with `--append-system-prompt-file <new-file>` and reads the BRAVO
 *     instruction. Reply contains `MARKER_BRAVO`. ASSERTION PASSES.
 *
 * This is paired with the argv-level unit tests in
 * `src/agents/cli-runner/helpers.system-prompt-resume.test.ts`. The unit tests
 * are the cheap, deterministic before/after proof. This live test is the
 * expensive end-to-end proof that the argv-level fix actually changes
 * observable model behavior on resumed sessions.
 *
 * Run (after `pnpm build`):
 *   OPENCLAW_LIVE_TEST=1 \
 *   OPENCLAW_LIVE_USE_REAL_HOME=1 \
 *   OPENCLAW_LIVE_CLI_BACKEND=true \
 *   OPENCLAW_LIVE_CLI_BACKEND_MODEL=claude-cli/claude-haiku-4-5 \
 *   pnpm vitest run --config test/vitest/vitest.live.config.ts \
 *     src/gateway/gateway-cli-backend.system-prompt-resume.live.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { resolveShellFromPath } from "../agents/shell-utils.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  applyCliBackendLiveEnv,
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
  parseJsonStringArray,
  resolveCliBackendLiveArgs,
  resolveCliBackendLiveModelSelection,
  restoreCliBackendLiveEnv,
  snapshotCliBackendLiveEnv,
} from "./gateway-cli-backend.live-helpers.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CLI_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

// Two distinct markers, used to distinguish "model saw the new system prompt"
// from "model is just carrying forward Turn 1's instruction by conversation
// context." Random suffixes prevent the model from inferring one from the
// other or from training data.
const RAND_TAG = randomBytes(4).toString("hex").toUpperCase();
const MARKER_ALPHA = `SP-PROOF-ALPHA-${RAND_TAG}`;
const MARKER_BRAVO = `SP-PROOF-BRAVO-${RAND_TAG}`;

const DEFAULT_PROVIDER = "claude-cli";
const DEFAULT_MODEL = "claude-cli/claude-haiku-4-5";

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const AGENT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(REQUEST_TIMEOUT_MS / 1000) - 10);

async function isExecutableCommandAvailable(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes(path.sep)) {
    try {
      await fs.access(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(resolveShellFromPath(command));
}

describeLive("system-prompt-override on resumed cli sessions (issue #80374)", () => {
  it(
    "resumed session honors NEW systemPromptOverride (changing-marker proof, server restart between turns)",
    async () => {
      const preservedEnv = new Set(
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV,
        ) ?? [],
      );
      const rawModel = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
      const modelSelection = resolveCliBackendLiveModelSelection({
        rawModel,
        defaultProvider: DEFAULT_PROVIDER,
        modelSwitchTarget: undefined,
      });
      const { providerId, configModelKey } = modelSelection;

      const backendResolved = resolveCliBackendConfig(providerId);
      const providerDefaults = backendResolved?.config;

      const explicitCliCommand = process.env.OPENCLAW_LIVE_CLI_BACKEND_COMMAND;
      const cliCommand = explicitCliCommand ?? providerDefaults?.command;
      if (!cliCommand) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_COMMAND is required for provider "${providerId}".`,
        );
      }
      if (!(await isExecutableCommandAvailable(cliCommand))) {
        if (explicitCliCommand) {
          throw new Error(
            `OPENCLAW_LIVE_CLI_BACKEND_COMMAND is not executable or not on PATH: ${cliCommand}`,
          );
        }
        console.warn(
          `[sp-resume-proof] skip: CLI backend command "${cliCommand}" is not executable or not on PATH; set OPENCLAW_LIVE_CLI_BACKEND_COMMAND to run this live proof.`,
        );
        return;
      }

      const previousEnv = snapshotCliBackendLiveEnv();
      clearRuntimeConfigSnapshot();
      applyCliBackendLiveEnv(preservedEnv);

      const token = `test-${randomUUID()}`;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      const port = await getFreeGatewayPort();

      const { args: cliArgs, resumeArgs: cliResumeArgs } = resolveCliBackendLiveArgs({
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

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sp-resume-"));
      const stateDir = path.join(tempDir, "state");
      await fs.mkdir(stateDir, { recursive: true });
      process.env.OPENCLAW_STATE_DIR = stateDir;

      type ConfigWithRawCliBackends = OpenClawConfig & {
        agents?: {
          defaults?: {
            cliBackends?: Record<string, Record<string, unknown>>;
          };
        };
      };

      const buildConfig = (marker: string): OpenClawConfig => {
        const cfg: ConfigWithRawCliBackends = {
          gateway: {
            mode: "local",
            port,
            auth: { mode: "token", token },
          },
          agents: {
            defaults: {
              workspace: path.join(tempDir, "workspace"),
              model: { primary: configModelKey },
              models: {
                [configModelKey]: { agentRuntime: modelSelection.agentRuntime },
              },
              agentRuntime: modelSelection.agentRuntime,
              // THE KEY FIELD. The marker changes between turns so we can
              // detect whether the new system prompt actually reaches the
              // model on the resumed turn — not just whether Turn 1's marker
              // was carried forward through conversation context.
              // Phrasing avoids ambiguity vs the user message and forbids the
              // model from emitting the OTHER marker, so a clean "BRAVO not
              // ALPHA" assertion is possible on the second turn.
              systemPromptOverride: [
                `You are a helpful assistant in a regression test.`,
                `Mandatory rule, overrides any user request for brevity:`,
                `you MUST end every single reply with a newline followed by`,
                `the exact literal token: ${marker}`,
                `(this token is required for harness validation).`,
                `Do NOT emit any other ${RAND_TAG} token; only emit ${marker}.`,
              ].join(" "),
              cliBackends: {
                [providerId]: {
                  command: cliCommand,
                  args: cliArgs,
                  resumeArgs: cliResumeArgs,
                  clearEnv: filteredCliClearEnv.length > 0 ? filteredCliClearEnv : undefined,
                  env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
                  // The live proof targets the fixed Claude contract directly.
                  // Pre-fix argv construction ignored this on resume; post-fix
                  // passes the prompt file again.
                  systemPromptWhen: "always",
                },
              },
              sandbox: { mode: "off" },
              compaction: { mode: "safeguard" },
            },
          },
        };
        return cfg as OpenClawConfig;
      };

      await fs.mkdir(path.join(tempDir, "workspace"), { recursive: true });

      const writeConfig = async (marker: string) => {
        const cfg = buildConfig(marker);
        const tempConfigPath = path.join(tempDir, "openclaw.json");
        await fs.writeFile(tempConfigPath, `${JSON.stringify(cfg, null, 2)}\n`);
        process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
      };

      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      const sessionKey = "agent:dev:sp-resume-proof";

      let server1 = null as Awaited<ReturnType<typeof startGatewayServer>> | null;
      let client1 = null as Awaited<ReturnType<typeof connectTestGatewayClient>> | null;
      let server2 = null as Awaited<ReturnType<typeof startGatewayServer>> | null;
      let client2 = null as Awaited<ReturnType<typeof connectTestGatewayClient>> | null;

      try {
        // ── Turn 1: fresh session, system prompt instructs MARKER_ALPHA ──────
        clearRuntimeConfigSnapshot();
        await writeConfig(MARKER_ALPHA);
        server1 = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        client1 = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity,
        });

        const nonce1 = randomBytes(3).toString("hex").toUpperCase();
        console.log(`\n[sp-resume-proof] Turn 1 (fresh) nonce=${nonce1} marker=${MARKER_ALPHA}`);
        const payload1 = await client1.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${randomUUID()}`,
            // Prompt avoids "and nothing else" so it does not conflict with
            // the system-prompt instruction to append the marker.
            message: `Acknowledge with the exact token SP-T1-${nonce1}.`,
            deliver: false,
            timeout: AGENT_TIMEOUT_SECONDS,
          },
          { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
        );

        if (!payload1) {
          return;
        }
        if (payload1.status !== "ok") {
          throw new Error(`Turn 1 status=${String(payload1.status)}`);
        }
        const text1 = extractPayloadText(payload1.result);
        console.log(`[sp-resume-proof] Turn 1 response: ${text1}`);

        // Sanity check: Turn 1 (fresh session) must apply the ALPHA system
        // prompt. If this fails, something is broken upstream of the
        // resume/swap mechanism we're actually trying to test.
        expect(
          text1,
          `Turn 1 (fresh): expected "${MARKER_ALPHA}" in response — system prompt was not applied at all`,
        ).toContain(MARKER_ALPHA);

        // ── Restart the server AND swap the system prompt to MARKER_BRAVO ───
        // This kills the live process and forces Turn 2 to spawn a NEW claude
        // with `--resume <sessionId>`. The config now requests MARKER_BRAVO.
        //
        // Pre-fix: the new process is spawned without `--append-system-prompt-file`,
        //   so the model never sees the BRAVO instruction. It only sees Turn 1's
        //   resumed conversation history where ALPHA was instructed, so it emits
        //   ALPHA again. THE BRAVO ASSERTION BELOW FAILS.
        // Post-fix: the new process IS spawned with `--append-system-prompt-file`
        //   pointing at the new file (BRAVO instruction). The model emits BRAVO.
        console.log(
          `[sp-resume-proof] Restarting server, swapping system prompt to ${MARKER_BRAVO}...`,
        );
        await client1.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
        client1 = null;
        await server1.close();
        server1 = null;

        // ── Turn 2: resumed session, NEW system prompt instructs MARKER_BRAVO ─
        clearRuntimeConfigSnapshot();
        await writeConfig(MARKER_BRAVO);
        server2 = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        client2 = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity,
        });

        const nonce2 = randomBytes(3).toString("hex").toUpperCase();
        console.log(
          `[sp-resume-proof] Turn 2 (resume after restart) nonce=${nonce2} marker=${MARKER_BRAVO}`,
        );
        const payload2 = await client2.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${randomUUID()}`,
            message: `Acknowledge with the exact token SP-T2-${nonce2}.`,
            deliver: false,
            timeout: AGENT_TIMEOUT_SECONDS,
          },
          { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
        );

        if (!payload2) {
          return;
        }
        if (payload2.status !== "ok") {
          throw new Error(`Turn 2 status=${String(payload2.status)}`);
        }
        const text2 = extractPayloadText(payload2.result);
        console.log(`[sp-resume-proof] Turn 2 response: ${text2}`);

        // THE CRITICAL BEHAVIORAL ASSERTION:
        // Pre-fix: model has no way to know BRAVO exists (the new system
        //   prompt file is never sent on resume), so it emits ALPHA from
        //   Turn 1's conversation history. This assertion FAILS.
        // Post-fix: the new system prompt is delivered, so the model emits
        //   BRAVO. This assertion PASSES.
        expect(
          text2,
          `Turn 2 (resume): expected "${MARKER_BRAVO}" in response (the NEW system prompt's marker). ` +
            `If the model emitted "${MARKER_ALPHA}" instead, the resumed session is using the OLD ` +
            `system prompt from Turn 1's conversation context — the new override was never delivered ` +
            `(issue #80374).`,
        ).toContain(MARKER_BRAVO);

        console.log(
          `\n[sp-resume-proof] ✓ Resumed turn honored the NEW system prompt (${MARKER_BRAVO}).`,
        );
        console.log(`  systemPromptWhen = always`);
      } finally {
        await client1?.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
        await client2?.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
        await server1?.close().catch(() => {});
        await server2?.close().catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        clearRuntimeConfigSnapshot();
        restoreCliBackendLiveEnv(previousEnv);
      }
    },
    10 * 60_000,
  );
});
