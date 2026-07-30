import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveApiKeyForProvider } from "../agents/model-auth-provider.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAppliedSnapshotConfig } from "./applied-snapshot-config.js";
import { projectInferenceRoute } from "./inference-route.js";
import { verifySetupInference } from "./setup-inference-verify.js";

const PROVIDER = "volcengine-plan";
const MODEL = "ark-code-latest";
const RESOLVED_KEY = "ark-live-key-abc123";

const cleanups: Array<() => void> = [];

afterEach(() => {
  resetConfigRuntimeState();
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
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
  cleanups.push(() => {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
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
    const auth = await resolveApiKeyForProvider({
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
