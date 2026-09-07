import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import type { resolveMcpLoopbackPolicyTools as ResolveMcpLoopbackPolicyTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
  createWeatherSkillFixture,
} from "../cli-runner.test-helpers.js";
import type { resolveSandboxContext as ResolveSandboxContext } from "../sandbox/context.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const resolveSandboxContext = vi.hoisted(() => vi.fn<typeof ResolveSandboxContext>());
vi.mock("../sandbox.js", () => ({
  resolveSandboxContext,
  ensureSandboxWorkspaceForSession: vi.fn(async () => null),
}));

describe("rooted CLI preparation", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let backend: CliBackendPlugin & { pluginId: string };
  const preparedRuns: PreparedCliRunContext[] = [];
  const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
  const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>();
  const mintGrant = vi.fn<typeof MintMcpLoopbackClientGrant>();
  const projectTools = vi.fn<typeof ResolveMcpLoopbackPolicyTools>();
  const prepareSkillsPlugin = vi.fn(async () => ({ args: [], cleanup: async () => {} }));

  beforeEach(() => {
    resolveSandboxContext.mockReset().mockResolvedValue(null);
    prepareExecution.mockReset().mockResolvedValue({ toolAvailabilityEnforced: true });
    mintGrant.mockReset().mockImplementation(createTestMcpLoopbackClientGrant);
    projectTools.mockReset().mockImplementation(async ({ context }) => ({
      agentId: "main",
      workspaceDir: context.workspaceDir,
      tools: ["read", "write", "exec", "apply_patch"]
        .filter(
          (name) =>
            context.toolsAllow === undefined ||
            context.toolsAllow.includes(name) ||
            (name === "apply_patch" && context.toolsAllow.includes("write")),
        )
        .map((name) => ({
          name,
          label: name,
          description: `Synthetic ${name} tool`,
          parameters: Type.Object({}),
          execute: vi.fn(),
        })),
    }));
    prepareSkillsPlugin.mockClear();
    backend = {
      ...buildDefaultTestCliBackend({ bundleMcp: true }),
      nativeToolMode: "selectable",
      isolatesInstructionsWithExactTools: true,
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      autoSelectAuthProfile: false,
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "synthetic-loopback-owner",
        nonOwnerToken: "synthetic-loopback-non-owner",
      }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: mintGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools: projectTools,
      resolveMcpLoopbackScopedTools: async (
        scope: Parameters<typeof ResolveMcpLoopbackPolicyTools>[0],
      ) => {
        const projected = await projectTools(scope);
        return {
          ...projected,
          tools: projected.tools.filter((tool) => scope.context.toolsAllow?.includes(tool.name)),
        };
      },
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: prepareSkillsPlugin,
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    for (const prepared of preparedRuns.splice(0)) {
      await prepared.preparedBackend.cleanup?.();
    }
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    fixture.cleanup();
  });

  async function prepare(overrides: Partial<RunCliAgentParams> = {}) {
    const admission =
      overrides.preparedRunAdmission ??
      prepareSystemAgentRunAdmission(
        overrides.config ?? {},
        overrides.runId ?? "run-test",
        "main",
        "rooted-preparation-test",
      );
    admissions.push(admission);
    const prepared = await fixture.prepare({
      rootedExecution: { root: path.join(fixture.session.dir, "workshop") },
      skillsSnapshot: { prompt: "", skills: [] },
      preparedRunAdmission: admission,
      ...overrides,
    });
    preparedRuns.push(prepared);
    return prepared;
  }

  it("disables native tools and retains the prepared filesystem authority only on the host grant", async () => {
    const prepared = await prepare();
    const root = path.join(fixture.session.dir, "workshop");
    const projectedCapability = projectTools.mock.calls[0]?.[0].rootedExecution;
    const grant = mintGrant.mock.calls[0]?.[0];

    expect(projectedCapability).toMatchObject({
      root,
      workspaceDir: root,
      cwd: root,
      requireWorkspaceOnly: true,
      sandbox: null,
    });
    expect(grant?.rootedExecution).toBe(projectedCapability);
    expect(grant?.context).not.toHaveProperty("rootedExecution");
    expect(prepared.params.disableCliLiveSession).toBe(true);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolAvailability: { native: [], openClaw: ["read", "write", "exec", "apply_patch"] },
      }),
    );
    expect(prepareExecution.mock.calls[0]?.[0]).not.toHaveProperty("rootedExecution");
  });

  it.each([
    { label: "runtime allowlist", policy: { toolsAllow: ["read"] }, expected: ["read"] },
    {
      label: "exact CLI availability",
      policy: { cliToolAvailability: { native: ["Read"], openClaw: ["read"] } },
      expected: ["read"],
    },
    {
      label: "exact write cap",
      policy: { cliToolAvailability: { native: [], openClaw: ["write"] } },
      expected: ["write"],
    },
  ])("preserves the caller's $label while disabling native tools", async ({ policy, expected }) => {
    await prepare(policy);

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ toolAvailability: { native: [], openClaw: expected } }),
    );
    expect(mintGrant.mock.calls[0]?.[0].context.toolsAllow).toEqual(expected);
  });

  it.each(["ro", "none"] as const)(
    "rejects a %s sandbox before issuing a grant or preparing the CLI",
    async (workspaceAccess) => {
      resolveSandboxContext.mockResolvedValue(
        createAgentToolsSandboxContext({ workspaceDir: fixture.session.dir, workspaceAccess }),
      );

      await expect(prepare()).rejects.toThrow("sandbox workspace is not read-write");
      expect(mintGrant).not.toHaveBeenCalled();
      expect(prepareExecution).not.toHaveBeenCalled();
    },
  );

  it("keeps an empty instruction snapshot when reviewed skills exist on disk", async () => {
    const root = path.join(fixture.session.dir, "workshop");
    const skill = createWeatherSkillFixture(root, true);
    const marker = "WORKSHOP_REVIEW_MATERIAL_IS_NOT_AN_INSTRUCTION";
    await fs.appendFile(skill.skillFilePath, `\n${marker}\n`);

    const prepared = await prepare({ workspaceDir: root });

    expect(prepared.systemPrompt).not.toContain(marker);
    expect(prepared.systemPrompt).not.toContain("Read forecast data before replying.");
    expect(prepared.systemPrompt).not.toContain(skill.skillFilePath);
    expect(prepared.params.skillsSnapshot).toEqual({ prompt: "", skills: [] });
    expect(prepareSkillsPlugin).not.toHaveBeenCalled();
  });

  it("retains the distinct policy owner's non-writable sandbox after execution admission", async () => {
    resolveSandboxContext.mockImplementation(async ({ agentId }) =>
      agentId === "other"
        ? createAgentToolsSandboxContext({
            workspaceDir: fixture.session.dir,
            workspaceAccess: "ro",
          })
        : null,
    );

    await expect(
      prepare({
        agentId: "other",
        sessionKey: "agent:main:main",
        runtimePolicySessionKey: "policy-session",
        config: {
          agents: {
            entries: {
              main: { default: true, sandbox: { mode: "off" } },
              other: { sandbox: { mode: "all", workspaceAccess: "ro" } },
            },
          },
        },
      }),
    ).rejects.toThrow("sandbox workspace is not read-write");
    expect(projectTools).not.toHaveBeenCalled();
    expect(mintGrant).not.toHaveBeenCalled();
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it("reports the prepared writable sandbox for a rooted run", async () => {
    const root = path.join(fixture.session.dir, "workshop");
    resolveSandboxContext.mockResolvedValue(createAgentToolsSandboxContext({ workspaceDir: root }));
    const prepared = await prepare({
      config: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } } },
    });
    expect(prepared.systemPromptReport.sandbox).toEqual({ mode: "all", sandboxed: true });
  });

  it("rejects an undeclared backend despite its exact native-tool support", async () => {
    delete backend.isolatesInstructionsWithExactTools;
    await expect(prepare()).rejects.toThrow(
      "does not declare instruction isolation with exact tools",
    );
    expect(resolveSandboxContext).not.toHaveBeenCalled();
    expect(mintGrant).not.toHaveBeenCalled();
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it.each(["closes", "is replaced"])(
    "does not prepare delegated tools after admission %s during sandbox preparation",
    async (loss) => {
      const runId = `rooted-admission-${loss}`;
      const admission = prepareSystemAgentRunAdmission(
        {},
        runId,
        "main",
        "rooted-preparation-test",
      );
      let replacement: typeof admission | undefined;
      resolveSandboxContext.mockImplementation(async () => {
        if (loss === "closes") {
          admission.close();
        } else {
          replacement = prepareSystemAgentRunAdmission(
            {},
            runId,
            "main",
            "rooted-preparation-test",
          );
          await replacement.admit("embedded");
        }
        return null;
      });
      try {
        await expect(prepare({ runId, preparedRunAdmission: admission })).rejects.toThrow(
          /authority.*active/,
        );
        expect(projectTools).not.toHaveBeenCalled();
        expect(mintGrant).not.toHaveBeenCalled();
        expect(prepareExecution).not.toHaveBeenCalled();
      } finally {
        replacement?.close();
        admission.close();
      }
    },
  );

  it("preserves ordinary CLI runs without an instruction-isolation declaration", async () => {
    delete backend.isolatesInstructionsWithExactTools;
    const prepared = await fixture.prepare();
    preparedRuns.push(prepared);
    expect(prepared.params.rootedExecution).toBeUndefined();
    expect(prepareExecution).toHaveBeenCalled();
  });

  it.each(["always-on native tools", "no MCP", "node placement"] as const)(
    "rejects %s before preparing a rooted CLI",
    async (unsupported) => {
      let overrides: Partial<RunCliAgentParams> = {};
      if (unsupported === "always-on native tools") {
        backend.nativeToolMode = "always-on";
      } else if (unsupported === "no MCP") {
        backend.bundleMcp = false;
      } else {
        backend.id = "claude-cli";
        overrides = {
          provider: "claude-cli",
          sessionEntry: {
            sessionId: "session-test",
            updatedAt: 0,
            execHost: "node",
            execNode: "synthetic-node",
          },
        };
      }

      await expect(prepare(overrides)).rejects.toThrow("cannot enforce rooted execution");
      expect(mintGrant).not.toHaveBeenCalled();
      expect(prepareExecution).not.toHaveBeenCalled();
    },
  );
});
