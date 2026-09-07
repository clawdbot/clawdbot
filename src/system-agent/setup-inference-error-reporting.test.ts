import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { runSystemAgentWithInference } from "../commands/system-agent-with-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as loggingConfig from "../logging/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  redactSetupInferenceError,
  type ActivateSetupInferenceDeps,
} from "./setup-inference-core.js";
import { verifySetupInferenceConfig } from "./setup-inference-verify.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "./system-agent.test-helpers.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

const runtimeLoader = vi.hoisted(() => vi.fn());
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: runtimeLoader,
}));

type FailurePhase = "capture" | "revalidate" | "callback";
type Scenario = FailurePhase | "success" | "drift";
const syntheticToken = "sk-140392syntheticfixturetoken123456789";
const syntheticStructuredValue = "140392-structured-placeholder";
const syntheticCustomValue = "PR140392_PRIVATE_SAMPLE";
const guidance = "Run `openclaw onboard` to connect and live-test AI first.";

async function observeScenario(scenario: Scenario, json: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-error-reporting-140392-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const phases: string[] = [];
  const tempDirs: string[] = [];
  let writes = 0;
  let callbackAttempts = 0;
  let managedDispatches = 0;
  let onboardingDispatches = 0;
  let faultReached = 0;
  const marker = `dependency-${scenario}-reason-140392`;
  const cause = `${marker}; OPENAI_API_KEY=${syntheticToken}; {"access_token":"${syntheticStructuredValue}"}; ${syntheticCustomValue}`;
  const fault = json ? new Error(cause) : cause;
  const renderedRuntime: RuntimeEnv = {
    log: (...args) => stdout.push(args.map(String).join(" ")),
    error: (...args) => stderr.push(args.map(String).join(" ")),
    exit: (code) => {
      exits.push(code);
    },
  };
  const policy = { redactSensitive: "off", redactPatterns: ["PR140392_PRIVATE_[A-Z]+"] };
  let restorePolicy = () => {};
  try {
    const policySpy = vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue(policy);
    restorePolicy = () => {
      policySpy.mockRestore();
    };
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "missing-config.json"),
      },
      async () => {
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              main: { default: true, workspace: root, agentDir: path.join(root, "main-agent") },
            },
            defaults: {
              model: "openai/gpt-5.5@openai:proof",
              models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
            },
          },
          auth: { profiles: { "openai:proof": { provider: "openai", mode: "api_key" } } },
        };
        const metadata = createSystemAgentPluginMetadataTestSnapshot(config);
        await metadata.run(async () => {
          const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
          let changedArtifact = false;
          const originalFingerprint = fixture.deps.fingerprintPluginRuntimeArtifact;
          if (!originalFingerprint) {
            throw new Error("fixture has no artifact fingerprint dependency");
          }
          runtimeLoader.mockReset().mockImplementation(() => {
            phases.push("runtime-load");
            if (scenario === "revalidate") {
              faultReached += 1;
              // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the verifier boundary.
              throw fault;
            }
            return createEmptyPluginRegistry();
          });
          const deps: ActivateSetupInferenceDeps = {
            ...fixture.deps,
            resolvePluginMetadataSnapshot: metadata.bind,
            readCodexCliActiveApiKey: () => null,
            updateAuthProfileStoreWithLock: async () => {
              writes += 1;
              throw new Error("unexpected credential write");
            },
            createTempDir: async () => {
              const dir = await fs.mkdtemp(path.join(root, "operation-"));
              tempDirs.push(dir);
              return dir;
            },
            removeTempDir: async (dir) => {
              await fs.rm(dir, { recursive: true, force: true });
            },
            fingerprintPluginRuntimeArtifact: (input) =>
              `${originalFingerprint(input)}${changedArtifact ? "-changed" : ""}`,
            captureSystemAgentOwnerPluginArtifacts: (input) => {
              phases.push("capture");
              if (scenario === "capture") {
                faultReached += 1;
                // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the verifier boundary.
                throw fault;
              }
              return captureSystemAgentOwnerPluginArtifacts(input);
            },
            runEmbeddedAgent: async (params) => {
              phases.push("probe");
              expect(params.agentHarnessRuntimeOverride).toBe("openclaw");
              expect(params.authProfileId).toBe("openai:proof");
              params.onSuccessfulAuthBinding?.(fixture.binding.auth);
              if (scenario === "drift") {
                changedArtifact = true;
              }
              return {
                meta: {
                  durationMs: 0,
                  finalAssistantVisibleText: "OK",
                  executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.5" },
                },
              };
            },
          };
          await runSystemAgentWithInference(
            json ? { json: true } : { message: "status", interactive: false },
            renderedRuntime,
            {},
            {
              verifyInference: async ({ runtime }) => {
                let binding: typeof fixture.binding | undefined;
                const result = await verifySetupInferenceConfig({
                  config,
                  agentId: "main",
                  runtime,
                  requireExecutionOwner: true,
                  deps,
                  onVerifiedExecution: (_auth, verified) => {
                    phases.push("callback");
                    callbackAttempts += 1;
                    if (scenario === "callback") {
                      faultReached += 1;
                      // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the verifier boundary.
                      throw fault;
                    }
                    binding = verified;
                  },
                });
                if (!result.ok) {
                  return result;
                }
                if (!binding) {
                  throw new Error("successful verification lacked a binding");
                }
                return { ...result, binding };
              },
              runSystemAgent: async () => {
                managedDispatches += 1;
              },
              runGuidedOnboarding: async () => {
                onboardingDispatches += 1;
              },
            },
          );
        });
      },
    );
    expect(writes).toBe(0);
    expect(onboardingDispatches).toBe(0);
    expect(tempDirs).toHaveLength(1);
    for (const dir of tempDirs) {
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (scenario === "success") {
      expect(phases).toEqual(["capture", "probe", "runtime-load", "callback"]);
      expect(callbackAttempts).toBe(1);
      expect(managedDispatches).toBe(1);
      expect(exits).toEqual([]);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
      return;
    }
    expect(managedDispatches).toBe(0);
    expect(exits).toEqual([1]);
    expect(callbackAttempts).toBe(scenario === "callback" ? 1 : 0);
    expect(phases).toEqual(
      scenario === "capture"
        ? ["capture"]
        : scenario === "callback"
          ? ["capture", "probe", "runtime-load", "callback"]
          : ["capture", "probe", "runtime-load"],
    );
    let message: string;
    if (json) {
      expect(stdout).toHaveLength(1);
      expect(stderr).toEqual([]);
      const payload = JSON.parse(expectDefined(stdout[0], "JSON output"));
      expect(payload).toMatchObject({
        ok: false,
        status: scenario === "capture" ? "unavailable" : "auth",
        guidance,
      });
      expect(payload).not.toHaveProperty("binding");
      message = payload.error;
    } else {
      expect(stdout).toEqual([]);
      expect(stderr).toHaveLength(1);
      const output = expectDefined(stderr[0], "text error");
      expect(output.endsWith(`\n${guidance}`)).toBe(true);
      message = output.slice(0, -guidance.length - 1);
    }
    expect(message.startsWith("OpenClaw requires working inference: ")).toBe(true);
    expect(message).not.toContain(syntheticToken);
    expect(message).not.toContain(syntheticStructuredValue);
    expect(message).not.toContain(syntheticCustomValue);
    if (scenario === "drift") {
      expect(faultReached).toBe(0);
      expect(message).toContain("verified inference owner changed");
      return;
    }
    expect(faultReached).toBe(1);
    if (scenario === "capture") {
      expect(message).toContain("Refresh or reinstall the plugin and retry.");
    }
    expect(message.includes(marker), "PR140392_CAUSE_LOST").toBe(true);
    expect(message.split(marker)).toHaveLength(2);
    expect(message).toContain("OPENAI_API_KEY=");
    expect(message).toContain("access_token");
    expect(message).toContain("***");
  } finally {
    try {
      runtimeLoader.mockReset();
      restorePolicy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      const evidenceDir = process.env.OPENCLAW_SETUP_ERROR_PROOF_DIR;
      if (evidenceDir) {
        await fs.writeFile(
          path.join(evidenceDir, `${scenario}-${json ? "json" : "text"}.json`),
          JSON.stringify(
            {
              scenario,
              json,
              stdout,
              stderr,
              exits,
              phases,
              faultReached,
              callbackAttempts,
              managedDispatches,
              onboardingDispatches,
              writes,
              tempDirsCreated: tempDirs.length,
              rootRemoved: true,
            },
            null,
            2,
          ),
        );
      }
    }
  }
}

describe("setup inference failure reporting", () => {
  it.each([
    ["capture", true],
    ["capture", false],
    ["revalidate", true],
    ["revalidate", false],
    ["callback", true],
    ["callback", false],
  ] as const)("preserves %s cause in JSON=%s", observeScenario);

  it("preserves a successful synthetic verification", async () => {
    await observeScenario("success", true);
  });
  it("keeps a real synthetic artifact mismatch rejected", async () => {
    await observeScenario("drift", true);
  });
  it("fully masks explicitly supplied known values", async () => {
    const known = "opaque-140392-placeholder";
    expect(await redactSetupInferenceError(`before ${known} after`, known)).toBe(
      "before [redacted] after",
    );
  });
});
