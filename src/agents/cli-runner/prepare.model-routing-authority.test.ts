// Exercises CLI routing receipts at the exact post-admission dispatch boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const auditConfig = {
  logging: { audit: { executionIdentity: true } },
} satisfies OpenClawConfig;

type AuthorityLoss = "close" | "replace";
type Producer = "normal" | "side-question";

function createInterleavedAdmission(params: { kind: AuthorityLoss; runId: string }): {
  admission: PreparedAgentRunAdmission;
  close: () => void;
} {
  let replacement: PreparedAgentRunAdmission | undefined;
  const loseAuthority = () => {
    if (params.kind === "close") {
      admission.close();
      return;
    }
    replacement = prepareAgentRunAdmission({
      cfg: auditConfig,
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      facts: {
        runId: params.runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "cli-authority-replacement", state: "present" },
      },
    });
    void replacement.admit("embedded").catch(() => undefined);
  };
  const admission = prepareAgentRunAdmission({
    cfg: auditConfig,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "cli-authority-test", state: "present" },
    },
    onAdmitted: () => {
      // Cross both admission promise continuations, then retire the exact claim
      // before the CLI producer resumes from its awaited resolver.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(loseAuthority)));
    },
  });
  return {
    admission,
    close: () => {
      admission.close();
      replacement?.close();
    },
  };
}

describe("CLI model-routing receipt authority", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let clearAdmissionSink: (() => void) | undefined;
  let clearDecisionSink: (() => void) | undefined;

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission: vi.fn(() => true),
      revokeMcpLoopbackClientGrant: vi.fn(() => true),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
      getCliLiveSessionGeneration: vi.fn(() => undefined),
      loadManifestModelCatalog: vi.fn(() => []),
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(() => {
    clearDecisionSink?.();
    clearAdmissionSink?.();
    clearDecisionSink = undefined;
    clearAdmissionSink = undefined;
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    fixture.cleanup();
  });

  it.each<{ kind: AuthorityLoss; producer: Producer }>([
    { kind: "close", producer: "normal" },
    { kind: "replace", producer: "normal" },
    { kind: "close", producer: "side-question" },
    { kind: "replace", producer: "side-question" },
  ])("drops $producer routing work when admission $kind wins the await", async (testCase) => {
    const runId = `run-cli-${testCase.producer}-${testCase.kind}`;
    const authority = createInterleavedAdmission({ kind: testCase.kind, runId });
    const decisionWork: ExecutionDecisionWork[] = [];
    const dispatch = vi.fn();
    clearAdmissionSink = configureExecutionIdentityAdmissionSink(() => true);
    clearDecisionSink = configureExecutionDecisionWorkSink((work) => {
      decisionWork.push(work);
      return true;
    });

    let preparationError: unknown;
    try {
      await fixture
        .prepare({
          runId,
          config: auditConfig,
          preparedRunAdmission: authority.admission,
          ...(testCase.producer === "side-question"
            ? { executionMode: "side-question" as const }
            : {}),
        })
        .then(dispatch)
        .catch((error: unknown) => {
          preparationError = error;
        });
    } finally {
      authority.close();
    }

    expect.soft(preparationError).toMatchObject({
      message: "admitted run authority is no longer active",
    });
    expect.soft(decisionWork).toEqual([]);
    expect.soft(dispatch).not.toHaveBeenCalled();
  });
});
