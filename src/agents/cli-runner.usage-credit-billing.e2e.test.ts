// Boundary proof for #122010: a real claude-cli child process reporting Claude
// subscription credit exhaustion must classify as `billing` — driving the auth-profile
// disable contract and cross-provider model fallback — instead of dying as `unknown`.
//
// Unlike the colocated predicate unit tests (failover/classify.message-predicates.test.ts),
// this spawns a real CLI child through the production process supervisor and drives the
// full seam: parseCliOutput -> createCliOutputFailoverError -> classifyFailoverReason ->
// settlePreparedCliRun profile disable -> runWithModelFallback. Only the two external
// boundaries are stubbed: the `claude` executable and the fallback provider's HTTP API.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { settlePreparedCliRun } from "./cli-runner/cli-run-settlement.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { describeFailoverError, isFailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

// Verbatim wording from the reported incident; the classifier must match this exact
// prose arriving as CLI stdout, not a hand-shaped variant.
const EXHAUSTION_TEXT =
  "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
const PROFILE_ID = "claude-cli:subscription";
const FALLBACK_ANSWER = "fallback provider answered";
const E2E_TIMEOUT_MS = 60_000;

let envSnapshot: ReturnType<typeof captureEnv>;
let tempRoot = "";
let agentDir = "";
let stubCliPath = "";
let fallbackBaseUrl = "";
let fallbackServer: http.Server | undefined;
let fallbackHits = 0;

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  // macOS os.tmpdir() is a /var -> /private/var symlink; realpath before any
  // production path resolution so recorded paths compare equal.
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oc-cli-billing-e2e-")));
  const stateDir = path.join(tempRoot, "state");
  agentDir = path.join(stateDir, "agents", "main", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

  // Boundary stub 1: the `claude` executable. Emits the stream-json terminal record the
  // real CLI produces for an exhausted subscription, then exits nonzero. Invoked through
  // the current node binary so the test has no PATH/shebang dependence.
  stubCliPath = path.join(tempRoot, "claude-stub.mjs");
  const terminalRecord = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: "00000000-0000-4000-8000-000000000001",
    result: EXHAUSTION_TEXT,
  };
  await fs.writeFile(
    stubCliPath,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(terminalRecord)}\n`)});\nprocess.exit(1);\n`,
    "utf8",
  );

  // Boundary stub 2: the fallback provider's HTTP endpoint.
  fallbackServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      fallbackHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: FALLBACK_ANSWER } }] }));
    });
  });
  fallbackBaseUrl = await new Promise<string>((resolve) => {
    fallbackServer?.listen(0, "127.0.0.1", () => {
      const addr = fallbackServer?.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });

  // Real SQLite auth-profile store with the one subscription login the incident used.
  const store = loadAuthProfileStoreForRuntime(agentDir);
  store.profiles[PROFILE_ID] = {
    type: "oauth",
    provider: "claude-cli",
    access: "synthetic-access-token-never-real",
    refresh: "synthetic-refresh-token-never-real",
    expires: Date.now() + 3_600_000,
  };
  saveAuthProfileStore(store, agentDir);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (fallbackServer) {
      fallbackServer.close(() => resolve());
    } else {
      resolve();
    }
  });
  envSnapshot?.restore();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  }
});

function buildStubCliContext(params: { runId: string; store: AuthProfileStore }) {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    model: "sonnet-4.6",
    runId: params.runId,
    sessionId: params.runId,
    sessionKey: `agent:main:${params.runId}`,
    workspaceDir: tempRoot,
    timeoutMs: 20_000,
    backend: { command: process.execPath, args: [stubCliPath] },
  });
  // The settle path only records profile health when the run carries its auth binding;
  // wire the same fields prepareCliRunContext resolves in production.
  context.agentDir = agentDir;
  context.effectiveAuthProfileId = PROFILE_ID;
  context.authProfileStore = params.store;
  return context;
}

async function fetchFallbackCompletion(): Promise<EmbeddedAgentRunResult> {
  const response = await fetch(`${fallbackBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const payload = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return {
    payloads: [{ text: payload.choices[0]?.message.content ?? "" }],
    meta: { durationMs: 1 },
  };
}

describe("claude-cli usage-credit exhaustion boundary (#122010)", () => {
  it(
    "classifies a real CLI credit-exhaustion exit as billing, disables the profile, and reaches the cross-provider fallback",
    async () => {
      const runId = `run-billing-${Date.now()}`;
      const attempts: string[] = [];
      const failoverReasons: string[] = [];

      const outcome = await runWithModelFallback<EmbeddedAgentRunResult>({
        cfg: undefined,
        provider: "claude-cli",
        model: "sonnet-4.6",
        agentId: "main",
        agentDir,
        sessionId: runId,
        runId,
        fallbacksOverride: ["openai/gpt-5.6-luna"],
        run: async (provider) => {
          attempts.push(provider);
          if (provider === "claude-cli") {
            // Production wiring from cli-runner.ts runCliAgent: spawn the real child
            // process, parse its stream-json, classify, and settle the auth profile.
            const context = buildStubCliContext({
              runId,
              store: loadAuthProfileStoreForRuntime(agentDir),
            });
            return await settlePreparedCliRun({
              context,
              run: async () => await runPreparedCliAgent(context),
            });
          }
          return await fetchFallbackCompletion();
        },
        onError: ({ error }) => {
          if (isFailoverError(error)) {
            failoverReasons.push(describeFailoverError(error).reason ?? "unknown");
          }
        },
      });

      // The CLI terminal error must classify as billing — `unknown` also retries
      // remaining candidates, but skips the billing recovery contract below.
      expect(failoverReasons).toEqual(["billing"]);

      // Billing recovery contract: the exhausted login is disabled with a long backoff
      // instead of a short generic cooldown, so later turns rotate off it.
      const settled = loadAuthProfileStoreForRuntime(agentDir);
      const stats = settled.usageStats?.[PROFILE_ID];
      expect(stats?.disabledReason).toBe("billing");
      expect(stats?.disabledUntil).toBeGreaterThan(Date.now());
      expect(stats?.failureCounts?.billing).toBe(1);

      // The turn is served by the healthy cross-provider candidate over real HTTP.
      expect(attempts).toEqual(["claude-cli", "openai"]);
      expect(fallbackHits).toBeGreaterThan(0);
      expect(outcome.result.payloads?.[0]?.text).toBe(FALLBACK_ANSWER);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "advances the embedded-result fallback chain when the same CLI text arrives as a terminal error payload",
    async () => {
      // Embedded-result path: the failure surfaces as an isError payload instead of a
      // thrown error. Here an unmatched classification is chain-fatal — the run is
      // accepted as terminal and no fallback candidate is attempted at all.
      const runId = `run-billing-embedded-${Date.now()}`;
      const attempts: string[] = [];
      const hitsBefore = fallbackHits;
      const exhaustedResult: EmbeddedAgentRunResult = {
        payloads: [{ text: EXHAUSTION_TEXT, isError: true }],
        meta: { durationMs: 1 },
      };

      const outcome = await runWithModelFallback<EmbeddedAgentRunResult>({
        cfg: undefined,
        provider: "claude-cli",
        model: "sonnet-4.6",
        agentId: "main",
        agentDir,
        sessionId: runId,
        runId,
        fallbacksOverride: ["openai/gpt-5.6-luna"],
        // Exact production classifier wiring from src/agents/runtime-plan/build.ts.
        classifyResult: ({ result }) =>
          classifyEmbeddedAgentRunResultForModelFallback({
            result,
            provider: "claude-cli",
            model: "sonnet-4.6",
          }),
        run: async (provider) => {
          attempts.push(provider);
          return provider === "claude-cli" ? exhaustedResult : await fetchFallbackCompletion();
        },
      });

      expect(attempts).toEqual(["claude-cli", "openai"]);
      expect(fallbackHits).toBeGreaterThan(hitsBefore);
      expect(outcome.result.payloads?.[0]?.text).toBe(FALLBACK_ANSWER);
    },
    E2E_TIMEOUT_MS,
  );
});
