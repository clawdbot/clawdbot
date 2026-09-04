import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import type { SystemAgentOverview } from "./overview.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { installSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";

const preparation = vi.hoisted(() => ({
  gateway: undefined as (() => Promise<void>) | undefined,
  execImport: undefined as (() => void) | undefined,
}));
vi.mock("../infra/exec-approvals.js", async (original) => {
  const actual = await original<typeof import("../infra/exec-approvals.js")>();
  return {
    ...actual,
    get updateExecApprovals() {
      preparation.execImport?.();
      return actual.updateExecApprovals;
    },
  };
});
vi.mock("../wizard/setup.gateway-config.js", async (original) => {
  const actual = await original<typeof import("../wizard/setup.gateway-config.js")>();
  return {
    ...actual,
    configureGatewayForSetup: async (
      ...args: Parameters<typeof actual.configureGatewayForSetup>
    ) => {
      await preparation.gateway?.();
      return await actual.configureGatewayForSetup(...args);
    },
  };
});

afterEach(() => {
  preparation.gateway = undefined;
  preparation.execImport = undefined;
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

// The approval queue has its own tests; exercise its synchronous admission contract through
// the real setup dispatcher and disk owners, substituting only inference and paused reads.
it.each([
  { phase: "config", loss: "close" },
  { phase: "config", loss: "replace" },
  { phase: "config", loss: "lifecycle" },
  { phase: "config", loss: "abort" },
  { phase: "first-agent", loss: "close" },
  { phase: "workspace", loss: "close" },
  { phase: "sessions", loss: "close" },
  { phase: "exec-approval", loss: "close" },
  { phase: "config", loss: "live" },
  { phase: "first-agent", loss: "live" },
  { phase: "first-agent", loss: "direct" },
] as const)("setup $phase preparation with $loss authority", async ({ phase, loss }) => {
  const state = await createOpenClawTestState({ label: "setup-lifetime" });
  const admission = prepareSystemAgentRunAdmission({}, "setup-run", "main", "setup-test");
  let replacement: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  const admitted = await admission.admit("embedded");
  const abort = new AbortController();
  const beforePersistentApply = resolveAdmittedRunActiveAssertion(admitted, abort.signal)!;
  const entered = createDeferred();
  const resume = createDeferred();
  let paused = false;
  let metadata: ReturnType<typeof installSystemAgentPluginMetadataTestSnapshot> | undefined;
  let completion: Promise<unknown> | undefined;
  const { runtime, lines } = createSystemAgentTestRuntime();
  const workspace = state.workspaceDir;
  const model = "anthropic/claude-sonnet-4-6";
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace,
        model,
        models: { [model]: { agentRuntime: { id: "openclaw" } } },
        ...(phase === "sessions" ? { skipBootstrap: true } : {}),
      },
      ...(phase === "first-agent" ? {} : { entries: { main: { workspace } } }),
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      tailscale: { mode: "off" },
      auth: { mode: "token", token: "synthetic-setup-token" },
    },
  };
  const pause = async () => {
    if (paused) {
      return;
    }
    paused = true;
    beforePersistentApply();
    entered.resolve();
    await resume.promise;
  };
  try {
    await state.writeConfig(config);
    metadata = installSystemAgentPluginMetadataTestSnapshot(
      (await readConfigFileSnapshot()).config,
    );
    const beforeRaw = await fs.readFile(state.configPath, "utf8");
    if (phase === "config") {
      preparation.gateway = pause;
    }
    const realAccess = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (
        (phase === "first-agent" || phase === "workspace") &&
        file === path.join(workspace, "AGENTS.md")
      ) {
        await pause();
      }
      return await realAccess(file, mode);
    });
    if (phase === "sessions") {
      const realReaddir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (args[0] === workspace) {
          await pause();
        }
        return await realReaddir(...args);
      });
    }
    if (phase === "exec-approval") {
      // Resolve the real mutation export after the awaited import, revoking its caller
      // before invocation. The real synchronous SQLite updater must never be entered.
      preparation.execImport = () => {
        beforePersistentApply();
        admission.close();
        paused = true;
        entered.resolve();
      };
    }
    completion = executeSystemAgentOperation({ kind: "setup", workspace }, runtime, {
      approved: true,
      ...(loss === "direct" ? {} : { beforePersistentApply }),
      deps: {
        setupSurface: "gateway",
        loadOverview: async () => ({ defaultModel: model }) as SystemAgentOverview,
        verifyInferenceConfig: async () => ({ ok: true, modelRef: model, latencyMs: 1 }),
      },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await withTestTimeout(
      Promise.race([
        entered.promise,
        completion.then((result) => {
          if (!paused) {
            throw new Error(`setup ended before pause: ${JSON.stringify(result)}`);
          }
        }),
      ]),
      10_000,
      "setup did not reach preparation pause",
    );
    const pauseRaw = await fs.readFile(state.configPath, "utf8");
    const pauseFiles = (await fs.readdir(workspace)).toSorted();
    if (loss === "close") {
      admission.close();
    }
    if (loss === "replace") {
      replacement = prepareSystemAgentRunAdmission(
        {},
        admitted.operationalRunInstance.runId,
        "main",
        "successor",
      );
      const successor = await replacement.admit("embedded");
      expect(successor.operationalRunInstance.instanceId).not.toBe(
        admitted.operationalRunInstance.instanceId,
      );
      expect(resolveAdmittedRunActiveAssertion(successor)).not.toThrow();
    }
    if (loss === "lifecycle") {
      rotateAgentEventLifecycleGeneration();
    }
    if (loss === "abort") {
      abort.abort();
    }
    const closed = loss !== "live" && loss !== "direct";
    if (closed) {
      expect(beforePersistentApply).toThrow("authority is no longer active");
    }
    resume.resolve();
    const outcome = await completion;
    const afterRaw = await fs.readFile(state.configPath, "utf8");
    if (closed) {
      expect
        .soft(outcome)
        .toMatchObject({ error: new Error("admitted run authority is no longer active") });
      expect.soft(afterRaw).toBe(pauseRaw);
      expect.soft((await fs.readdir(workspace)).toSorted()).toEqual(pauseFiles);
      if (phase !== "exec-approval") {
        expect.soft(await fs.stat(state.sessionsDir()).catch(() => null)).toBeNull();
      }
      expect.soft(loadExecApprovalsReadOnly().agents?.openclaw).toBeUndefined();
      expect.soft(lines).not.toContain("[openclaw] done: openclaw.setup");
    } else {
      expect(outcome).toMatchObject({ result: { applied: true, bootstrapPending: true } });
      expect(afterRaw).not.toBe(beforeRaw);
      expect(JSON.parse(afterRaw)).toHaveProperty("agents.entries.main");
      expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
      expect((await fs.stat(state.sessionsDir())).isDirectory()).toBe(true);
      expect(loadExecApprovalsReadOnly().agents?.openclaw).toEqual({
        security: "full",
        ask: "off",
      });
    }
  } finally {
    resume.resolve();
    await completion;
    admission.close();
    replacement?.close();
    metadata?.restore();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});
