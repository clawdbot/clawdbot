import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveAppliedSnapshotConfig } from "./applied-snapshot-config.js";
import { projectInferenceRoute } from "./inference-route.js";
import { executeSystemAgentOperation } from "./operations.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { verifySetupInference } from "./setup-inference-verify.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const PROVIDER = "volcengine-plan";
const MODEL = "ark-code-latest";
const RESOLVED_KEY = "ark-live-key-abc123";

const cleanups: Array<() => void> = [];

afterEach(() => {
  resetConfigRuntimeState();
  // Persistent-setup cases reach the audit writer, which caches an open handle
  // on the shared SQLite state DB under the fixture root; close it before the
  // cleanups delete that root so rmSync cannot fail with EBUSY on Windows.
  closeOpenClawStateDatabaseForTest();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/** Config file with a file-backed SecretRef provider key, as the reporter had. */
function writeSecretRefConfig(): { root: string } {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "setup-inference-secretref-")),
  );
  const secretsFile = path.join(root, "openclaw-secrets.json");
  fs.writeFileSync(secretsFile, JSON.stringify({ volcano_engine_api_key: RESOLVED_KEY }), {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({
      models: {
        providers: {
          [PROVIDER]: {
            baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
            api: "openai-completions",
            apiKey: { source: "file", provider: "local_file", id: "/volcano_engine_api_key" },
            models: [{ id: MODEL, name: MODEL }],
          },
        },
      },
      agents: { defaults: { model: { primary: `${PROVIDER}/${MODEL}` } } },
      secrets: { providers: { local_file: { source: "file", path: secretsFile, mode: "json" } } },
    }),
  );

  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
  // Persistent-setup tests reach the audit writer, which opens a SQLite store
  // under the shared state dir; isolate it so tests never touch real state.
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  cleanups.push(() => {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

/** Publish the applied runtime state: resolved credential in the runtime config,
 *  untouched SecretRef in the source config, as the Gateway does at startup. */
async function publishAppliedRuntimeConfig(): Promise<OpenClawConfig> {
  const startup = await readConfigFileSnapshot();
  const runtimeConfig = structuredClone(startup.runtimeConfig ?? startup.config) as OpenClawConfig;
  const providerEntry = runtimeConfig.models?.providers?.[PROVIDER] as { apiKey?: unknown };
  providerEntry.apiKey = RESOLVED_KEY;
  setAppliedRuntimeConfigSnapshot(runtimeConfig, startup.sourceConfig);
  return runtimeConfig;
}

test("the setup-inference probe keeps a SecretRef provider key the Gateway resolved", async () => {
  const { root } = writeSecretRefConfig();
  await publishAppliedRuntimeConfig();

  // Stub only model execution; resolve the credential exactly as the runner does.
  let probedKey: string | undefined;
  const runEmbeddedAgent = async (params: {
    config: OpenClawConfig;
    provider: string;
    agentDir?: string;
  }) => {
    const auth = await resolveApiKeyForProviderCore({
      provider: params.provider,
      cfg: params.config,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      modelApi: "openai-completions",
    });
    probedKey = auth.apiKey;
    return {
      meta: {
        finalAssistantVisibleText: "OK",
        executionTrace: { winnerProvider: PROVIDER, winnerModel: MODEL },
      },
    };
  };

  const runtime: RuntimeEnv = { log: () => {}, error: () => {}, exit: () => {} };
  const result = await verifySetupInference({
    runtime,
    deps: {
      runEmbeddedAgent: runEmbeddedAgent as never,
      createTempDir: async () => fs.mkdtempSync(path.join(root, "probe-")),
    },
  });

  expect(result).toMatchObject({ ok: true, modelRef: `${PROVIDER}/${MODEL}` });
  expect(probedKey).toBe(RESOLVED_KEY);
});

test("existing-model activation keeps a SecretRef provider key the Gateway resolved", async () => {
  // Before this fix, activateSetupInferenceUnredacted's initial cfg read the raw file
  // snapshot (`snapshot.runtimeConfig ?? snapshot.config`) instead of the applied one,
  // so a file SecretRef stayed unresolved during existing-model activation even though
  // the same probe already worked through verifySetupInference above.
  const { root } = writeSecretRefConfig();
  await publishAppliedRuntimeConfig();

  let probedKey: string | undefined;
  const runEmbeddedAgent = async (params: {
    config: OpenClawConfig;
    provider: string;
    agentDir?: string;
  }) => {
    const auth = await resolveApiKeyForProviderCore({
      provider: params.provider,
      cfg: params.config,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      modelApi: "openai-completions",
    });
    probedKey = auth.apiKey;
    return {
      meta: {
        finalAssistantVisibleText: "OK",
        executionTrace: { winnerProvider: PROVIDER, winnerModel: MODEL },
      },
    };
  };

  const runtime: RuntimeEnv = { log: () => {}, error: () => {}, exit: () => {} };
  await activateSetupInference({
    kind: "existing-model",
    surface: "cli",
    runtime,
    deps: {
      runEmbeddedAgent: runEmbeddedAgent as never,
      createTempDir: async () => fs.mkdtempSync(path.join(root, "activate-")),
    },
  });

  // The credential resolution happens before owner attestation, so it is provable
  // regardless of whether this bare stub run goes on to report a full owner binding.
  expect(probedKey).toBe(RESOLVED_KEY);
});

test("the applied-config selection projects an identical inference route", async () => {
  writeSecretRefConfig();
  const runtimeConfig = await publishAppliedRuntimeConfig();

  // A verified binding is fingerprinted from the applied config, then revalidated
  // against a fresh read in verified-inference.ts. Those projections carry the
  // provider entry verbatim, so an unresolved SecretRef on one side alone would
  // reject every later system-agent session as stale-route.
  const appliedProjection = await projectInferenceRoute(runtimeConfig);
  const revalidationProjection = await projectInferenceRoute(
    resolveAppliedSnapshotConfig(await readConfigFileSnapshot()),
  );

  expect(revalidationProjection).toEqual(appliedProjection);
});

test("persistent setup succeeds when the post-probe re-read keeps an unchanged file SecretRef", async () => {
  const { root } = writeSecretRefConfig();
  await publishAppliedRuntimeConfig();
  const { runtime } = createSystemAgentTestRuntime();
  const modelRef = `${PROVIDER}/${MODEL}`;
  const applySetup = vi.fn(async () => ({
    configPath: path.join(root, "openclaw.json"),
    configHashBefore: "before",
    configHashAfter: "after",
    bootstrapPending: false,
    workspaceReady: true,
    gateway: { status: "ready" as const, action: "reused" as const },
    lines: [],
  }));

  // Before this fix, verifyCurrentSetupInference's post-probe comparison read
  // the config file raw instead of through resolveAppliedSnapshotConfig, so an
  // untouched file SecretRef looked like route drift and setup was refused.
  const result = await executeSystemAgentOperation(
    { kind: "setup", workspace: path.join(root, "work") },
    runtime,
    {
      approved: true,
      deps: {
        applySetup,
        loadOverview: async () => ({ defaultModel: modelRef }) as never,
        verifyInferenceConfig: async () => ({ ok: true as const, modelRef, latencyMs: 5 }),
      },
    },
  );

  expect(result.applied).toBe(true);
  expect(applySetup).toHaveBeenCalledOnce();
});

test("persistent setup still fails closed when the route genuinely changes mid-verification", async () => {
  const { root } = writeSecretRefConfig();
  await publishAppliedRuntimeConfig();
  const { runtime } = createSystemAgentTestRuntime();
  const modelRef = `${PROVIDER}/${MODEL}`;
  const configPath = path.join(root, "openclaw.json");
  const applySetup = vi.fn();

  await expect(
    executeSystemAgentOperation({ kind: "setup", workspace: path.join(root, "work") }, runtime, {
      approved: true,
      deps: {
        applySetup,
        loadOverview: async () => ({ defaultModel: modelRef }) as never,
        verifyInferenceConfig: async () => {
          // A real concurrent edit during the probe: rotate the auth profile
          // order for the active provider. The applied-snapshot selector must
          // not mask this as "still resolved"; the disk source no longer
          // matches the source captured when the runtime snapshot was applied.
          const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
          current.auth = { order: { [PROVIDER]: ["rotated-profile"] } };
          fs.writeFileSync(configPath, JSON.stringify(current));
          return { ok: true as const, modelRef, latencyMs: 5 };
        },
      },
    }),
  ).rejects.toThrow("changed during setup verification");

  expect(applySetup).not.toHaveBeenCalled();
});
