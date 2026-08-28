import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  createCronScheduledToolProjection,
  readCronScheduledToolProjection,
} from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { resolveAgentHarnessScheduledToolProjectionCapability } from "./host-private-capabilities.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(runId: string): Promise<HostAttempt> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId,
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
    currentChannelId: "chat-1",
    messageChannel: "telegram",
    admittedRunContext: await admission.admit("plugin-harness", `harness-${runId}`),
  };
}

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness scheduled tool projection", () => {
  it("issues scheduled shell projections only from this host-created tool surface", async () => {
    const attempt = await admittedAttempt("run-scheduled-tool-projection");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const sourceTools = host.capabilities.createToolSurface?.({}) ?? [];
    const execTool = sourceTools.find((tool) => tool.name === "exec");
    const createProjection = resolveAgentHarnessScheduledToolProjectionCapability({
      hostCapabilities: host.capabilities,
      ownerPluginId: "codex",
    });
    if (!execTool || !createProjection) {
      throw new Error("expected host-created exec projection test surface");
    }
    const alias = createProjection(execTool, {
      kind: "exec",
      name: "gateway_exec",
      description: "Gateway exec",
      followupText: "Use gateway_process for follow-up.",
    });
    expect(readCronScheduledToolProjection(alias)).toEqual({
      targetTool: "exec",
      execTarget: { host: "gateway" },
    });

    // A shallow same-name copy is a different object: no projection identity.
    expect(readCronScheduledToolProjection({ ...alias })).toBeUndefined();

    // Swapping the alias executable after host creation is a tamper signal.
    const renamedAlias = { ...alias };
    Object.assign(alias, { execute: async () => ({ content: [], details: {} }) });
    expect(() => readCronScheduledToolProjection(alias)).toThrow("changed after host creation");
    Object.assign(alias, { execute: renamedAlias.execute });

    // A source whose executable was swapped is not the host-created shell tool.
    const forgedExecute = async () => ({ content: [], details: {} });
    const sourceExecute = execTool.execute;
    execTool.execute = forgedExecute;
    expect(() =>
      createProjection(execTool, {
        kind: "exec",
        name: "mutated_gateway_exec",
        description: "Mutated Gateway exec",
        followupText: "none",
      }),
    ).toThrow("was not created by this host capability");
    execTool.execute = sourceExecute;

    // A plugin-bound copy of exec is not the host-created source object.
    const pluginExec = { ...execTool, name: "exec" };
    const [boundPluginExec] = host.capabilities.bindToolSurface([pluginExec]);
    expect(() =>
      createProjection(boundPluginExec!, {
        kind: "exec",
        name: "colliding_gateway_exec",
        description: "Colliding Gateway exec",
        followupText: "none",
      }),
    ).toThrow("was not created by this host capability");

    // A non-shell host tool renamed to exec never gains shell projection rights.
    const nonShellTool = sourceTools.find(
      (tool) => tool.name !== "exec" && tool.name !== "process",
    );
    if (!nonShellTool) {
      throw new Error("expected a non-shell host-created tool");
    }
    nonShellTool.name = "exec";
    expect(() =>
      createProjection(nonShellTool, {
        kind: "exec",
        name: "forged_gateway_exec",
        description: "Forged Gateway exec",
        followupText: "none",
      }),
    ).toThrow("was not created by this host capability");

    host.close();
    expect(() => readCronScheduledToolProjection(alias)).toThrow();
  });

  it("keeps scheduled shell issuance private to the registered owner plugin", async () => {
    const attempt = await admittedAttempt("run-non-codex-projection");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "other-harness" });

    expect(
      resolveAgentHarnessScheduledToolProjectionCapability({
        hostCapabilities: host.capabilities,
        ownerPluginId: "codex",
      }),
    ).toBeUndefined();
    host.close();
  });

  it("constructs scheduled exec projections with host-owned policy", async () => {
    const execute = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: "Command still running. Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
        },
      ],
      details: {},
    }));
    const source = {
      name: "exec",
      label: "Exec",
      description: "exec",
      parameters: Type.Object({}),
      execute,
    } satisfies AnyAgentTool;
    const alias = createCronScheduledToolProjection(source, () => {}, "exec", {
      kind: "exec",
      name: "gateway_exec",
      description: "Gateway exec",
      followupText: "Use gateway_process for follow-up.",
      ask: "always",
    });

    const result = await alias.execute("call-1", {
      command: "echo safe",
      host: "node",
      node: "remote",
      security: "full",
      ask: "off",
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { command: "echo safe", host: "gateway", ask: "always" },
      undefined,
      undefined,
    );
    expect(readCronScheduledToolProjection(alias)).toEqual({
      targetTool: "exec",
      execTarget: { host: "gateway", ask: "always" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Command still running. Use gateway_process for follow-up." },
    ]);
  });
});
