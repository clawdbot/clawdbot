import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginHookBeforeToolCallEvent } from "../plugins/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  noteClientVoiceConfirmationUtterance,
} from "../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../talk/client-voice-confirmation.test-support.js";
import * as clientVoiceSession from "../talk/client-voice-session.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import * as nodeHost from "./bash-tools.exec-host-node.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import * as codeModeBridge from "./code-mode-bridge.js";
import { consumeRepairableCodeModeFailure } from "./code-mode-repair-provenance.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";
import { jsonResult, ToolInputError } from "./tools/common.js";
import * as gatewayTool from "./tools/gateway.js";

const sandbox = {
  containerName: "test-sandbox",
  workspaceDir: process.cwd(),
  containerWorkdir: "/workspace",
};
const deniedCode = 'return await exec({ command: "printf host-denied", host: "node" });';

function installBefore(
  handler: (event: PluginHookBeforeToolCallEvent) => unknown = () => undefined,
) {
  const before = vi.fn(handler);
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", handler: before as (...args: unknown[]) => unknown },
    ]),
  );
  return before;
}

function createHostHarness(
  options: Parameters<typeof createSubscribedCodeModeHarness>[0] & {
    defaults?: ExecToolDefaults;
    hookContext?: HookContext;
    approvalMode?: "report";
  },
) {
  const harness = createSubscribedCodeModeHarness(options);
  const source = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    ...options.defaults,
  });
  const shell = wrapToolWithBeforeToolCallHook(
    source,
    { runId: harness.runId, sessionKey: harness.sessionKey, ...options.hookContext },
    { approvalMode: options.approvalMode },
  );
  applyCodeModeCatalog({ ...harness, tools: [...harness.tools, shell] });
  let nextCall = 0;
  const run = async (code = deniedCode) =>
    resultDetails(
      await expectDefined(harness.tools[0], "outer exec").execute(`host-${nextCall++}`, { code }),
    );
  const complete = (details: Record<string, unknown>) =>
    waitUntilCompleted({ details, waitTool: expectDefined(harness.tools[1], "wait") });
  return {
    ...harness,
    source,
    shell,
    spawn: vi.spyOn(getProcessSupervisor(), "spawn"),
    remote: vi.spyOn(nodeHost, "executeNodeHostCommand"),
    run,
    complete,
    runToCompletion: async (code = deniedCode) => complete(await run(code)),
  };
}

describe("Code Mode subscribed host denial", () => {
  afterEach(() => {
    resetCodeModeTestState();
    resetGlobalHookRunner();
    resetAdjustedParamsByToolCallIdForTests();
    vi.restoreAllMocks();
  });

  it.each([
    {
      policy: "gateway",
      defaults: { host: "gateway" },
      args: { host: "node" },
      error: "exec host not allowed",
    },
    {
      policy: "auto-sandbox",
      defaults: { host: "auto", sandbox },
      args: { host: "gateway" },
      error: "exec host not allowed",
    },
    {
      policy: "required-missing",
      defaults: { sandboxRequired: true },
      args: {},
      error: "sandbox runtime is unavailable",
    },
    {
      policy: "required-elevation",
      defaults: {
        sandboxRequired: true,
        sandbox,
        elevated: { enabled: true, allowed: true, defaultLevel: "off" },
      },
      args: { elevated: true },
      error: "Elevated execution is unavailable",
    },
    {
      policy: "required-outside",
      defaults: { sandboxRequired: true, sandbox },
      args: { host: "gateway" },
      error: "this session requires a sandbox",
    },
  ] satisfies Array<{ policy: string; defaults: ExecToolDefaults; args: object; error: string }>)(
    "preserves operation no-start through the real subscriber for $policy",
    async ({ policy, defaults, args, error }) => {
      const before = installBefore();
      const observeToolTerminal = vi.fn(createToolTerminalObserver(`run-code-mode-host-${policy}`));
      const harness = createHostHarness({ name: `host-${policy}`, defaults, observeToolTerminal });
      try {
        const details = await harness.runToCompletion(
          `return await exec(${JSON.stringify({ command: "printf host-denied", ...args })});`,
        );
        expect(details).toMatchObject({
          status: "failed",
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
        });
        expect(details.error).toContain(error);
        expect(before).toHaveBeenCalledOnce();
        expect(observeToolTerminal).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "exec", executionStarted: true, outcome: "failure" }),
        );
        expect(harness.spawn).not.toHaveBeenCalled();
        expect(harness.remote).not.toHaveBeenCalled();
        expect(harness.subscription.getItemLifecycle()).toMatchObject({
          startedCount: 2,
          completedCount: 2,
          activeCount: 0,
        });
        const serialized = JSON.stringify(details);
        for (const copy of [{ ...details }, structuredClone(details), JSON.parse(serialized)]) {
          expect(consumeRepairableCodeModeFailure(copy)).toBe(false);
        }
        expect(consumeRepairableCodeModeFailure(details)).toBe(true);
        expect(consumeRepairableCodeModeFailure(details)).toBe(false);
      } finally {
        harness.dispose();
      }
    },
  );
  it.each(["repair", "deny", "veto", "throw", "invalid"] as const)(
    "judges final host arguments after one real hook: %s",
    async (change) => {
      const before = installBefore(() => {
        if (change === "throw") {
          throw new Error("hook failed");
        }
        if (change === "veto") {
          return { block: true, blockReason: "hook veto" };
        }
        return {
          params: {
            command: "printf host-corrected",
            host: change === "repair" ? "gateway" : "node",
            ...(change === "invalid" ? { command: 42 } : {}),
          },
        };
      });
      const timeoutMs = 1_500;
      const harness = createHostHarness({
        name: `hook-${change}`,
        timeoutMs,
        onToolStreamBoundary:
          change === "repair"
            ? () => {
                // Exhaust the call budget after the real command completes, before VM restore.
                vi.advanceTimersByTime(timeoutMs);
              }
            : undefined,
      });
      if (change === "repair") {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      }
      try {
        const waitTool = expectDefined(harness.tools[1], "wait");
        const wait = vi.spyOn(waitTool, "execute");
        const details = await harness.runToCompletion(
          change === "repair"
            ? deniedCode
            : 'return await exec({ command: "printf initial", host: "gateway" });',
        );
        expect(before).toHaveBeenCalledOnce();
        expect(harness.remote).not.toHaveBeenCalled();
        expect(harness.spawn).toHaveBeenCalledTimes(change === "repair" ? 1 : 0);
        expect(details.status).toBe(
          change === "repair" || change === "veto" ? "completed" : "failed",
        );
        if (change === "veto") {
          expect(details.value).toMatchObject({ status: "blocked", reason: "hook veto" });
        }
        if (change === "repair") {
          expect(wait).toHaveBeenCalledOnce();
          expect(details.value).toMatchObject({ exitCode: 0, aggregated: "host-corrected" });
        }
        expect(consumeRepairableCodeModeFailure(details)).toBe(
          change === "deny" || change === "invalid",
        );
      } finally {
        harness.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "allow-once",
    "allow-always",
    "deny",
    "timeout",
    "cancel",
    "unavailable",
    "report",
  ] as const)("preserves approval callbacks and containment for %s", async (decision) => {
    const resolutions: string[] = [];
    const requests: string[] = [];
    const before = installBefore(() => ({
      requireApproval: {
        title: "Confirm command",
        description: "Review host command",
        onResolution: (value: string) => resolutions.push(value),
      },
    }));
    const rpc = vi.spyOn(gatewayTool, "callGatewayTool").mockImplementation(async (method) => {
      requests.push(method);
      if (decision === "unavailable") {
        throw new Error("gateway unavailable");
      }
      if (method === "plugin.approval.request") {
        return { id: "host-approval", status: "accepted" };
      }
      if (decision === "cancel") {
        throw new Error("approval route closed");
      }
      return { id: "host-approval", decision: decision === "timeout" ? null : decision };
    });
    const harness = createHostHarness({
      name: `approval-${decision}`,
      ...(decision === "report" ? { approvalMode: "report" } : {}),
    });
    try {
      const allowed = decision === "allow-once" || decision === "allow-always";
      const details = await harness.runToCompletion();
      expect(details.status).toBe("failed");
      expect(consumeRepairableCodeModeFailure(details)).toBe(allowed);
      expect(before).toHaveBeenCalledOnce();
      expect(resolutions).toEqual([
        decision === "cancel" || decision === "unavailable" || decision === "report"
          ? "cancelled"
          : decision,
      ]);
      expect(requests).toEqual(
        decision === "report"
          ? []
          : decision === "unavailable"
            ? ["plugin.approval.request"]
            : ["plugin.approval.request", "plugin.approval.waitDecision"],
      );
      expect(harness.spawn).not.toHaveBeenCalled();
      expect(harness.remote).not.toHaveBeenCalled();
      if (allowed) {
        const corrected = await harness.runToCompletion(
          'return await exec({ command: "printf approved-correction", host: "gateway" });',
        );
        expect(corrected).toMatchObject({
          status: "completed",
          value: { exitCode: 0, aggregated: "approved-correction" },
        });
        expect(before).toHaveBeenCalledTimes(2);
        expect(resolutions).toEqual([decision, decision]);
        expect(rpc).toHaveBeenCalledTimes(4);
        expect(harness.spawn).toHaveBeenCalledOnce();
      }
    } finally {
      harness.dispose();
    }
  });

  it("keeps the approved host snapshot frozen against later hook rewrites", async () => {
    const approve = vi.fn(() => ({
      params: { command: "printf approved", host: "node" },
      requireApproval: { title: "Approve", description: "Exact host" },
    }));
    const rewrite = vi.fn(() => ({ params: { command: "printf changed", host: "gateway" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: approve, priority: 1 },
        { hookName: "before_tool_call", handler: rewrite },
      ]),
    );
    vi.spyOn(gatewayTool, "callGatewayTool").mockResolvedValue({
      id: "frozen",
      decision: "allow-once",
    });
    const harness = createHostHarness({ name: "approval-freeze" });
    try {
      const details = await harness.runToCompletion();
      expect(details.error).toContain("requested node");
      expect(consumeRepairableCodeModeFailure(details)).toBe(true);
      expect(approve).toHaveBeenCalledOnce();
      expect(rewrite).toHaveBeenCalledOnce();
      expect(harness.spawn).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it.each(["hook", "approval", "preparation", "completion"] as const)(
    "does not resurrect cancellation-ignoring work across awaited %s",
    async (boundary) => {
      const entered = createDeferred();
      const release = createDeferred();
      const finished = createDeferred();
      const pause = async () => {
        entered.resolve();
        await release.promise;
        finished.resolve();
      };
      if (boundary === "hook") {
        installBefore(pause);
      }
      if (boundary === "approval") {
        installBefore(() => ({ requireApproval: { title: "Approve", description: "Wait" } }));
        vi.spyOn(gatewayTool, "callGatewayTool").mockImplementation(async (method) => {
          if (method === "plugin.approval.request") {
            return { id: "late", status: "accepted" };
          }
          await pause();
          return { id: "late", decision: "allow-once" };
        });
      }
      const harness = createHostHarness({
        name: `abort-${boundary}`,
        ...(boundary === "completion" ? { onToolStreamBoundary: pause } : {}),
      });
      if (boundary === "preparation") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            { hookName: "resolve_exec_env", handler: pause },
            {
              hookName: "before_tool_call",
              handler: () => ({ params: { command: "printf no", host: "node" } }),
            },
          ]),
        );
      }
      const after = pluginToolWithExecute("after_abort", "Must not run after abort", async () =>
        jsonResult({ ran: true }),
      );
      applyCodeModeCatalog({ ...harness, tools: [...harness.tools, harness.shell, after] });
      try {
        const code =
          boundary === "preparation"
            ? deniedCode.replace('host: "node"', 'host: "gateway"')
            : deniedCode;
        const running = harness.run(`${code.replace("return ", "")} await after_abort({});`);
        await entered.promise;
        harness.runAbortController.abort(new Error("cancel host test"));
        const details = await running;
        expect(details).toMatchObject({ status: "failed" });
        expect(details.error).toMatch(/abort|cancel/i);
        expect(consumeRepairableCodeModeFailure(details)).toBe(false);
        release.resolve();
        await finished.promise;
        await vi.waitFor(() => expect(harness.subscription.getItemLifecycle().activeCount).toBe(0));
        expect(harness.spawn).not.toHaveBeenCalled();
        expect(harness.remote).not.toHaveBeenCalled();
        expect(after.execute).not.toHaveBeenCalled();
        expect(testing.activeRuns.size).toBe(0);
      } finally {
        release.resolve();
        harness.dispose();
      }
    },
  );

  it("does not transfer the consumed fact when awaited completion replaces the error", async () => {
    const replacement = new Error("completion observer failed");
    const harness = createHostHarness({
      name: "completion-replacement",
      observeToolTerminal: () => {
        throw replacement;
      },
    });
    const execute = harness.source.execute;
    let producerError: unknown;
    // Capture the exact real producer object without minting or modifying its proof.
    const capture = wrapToolWithBeforeToolCallHook(
      {
        ...harness.source,
        execute: async (...args: Parameters<typeof execute>) => {
          try {
            return await execute(...args);
          } catch (error) {
            producerError = error;
            throw error;
          }
        },
      },
      { runId: harness.runId },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, capture] });
    try {
      const details = await harness.runToCompletion();
      expect(details.error).toContain(replacement.message);
      expect(producerError).toBeInstanceOf(Error);
      expect(consumeTrustedToolNoStartError(producerError)).toBe(false);
      expect(consumeTrustedToolNoStartError(replacement)).toBe(false);
      expect(consumeRepairableCodeModeFailure(details)).toBe(false);
      expect(harness.spawn).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("ignores an after-tool plugin return without replacing the operation fact", async () => {
    const after = vi.fn(() => ({ terminate: true, result: { status: "completed" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: after }]),
    );
    const harness = createHostHarness({ name: "after-observer" });
    try {
      const details = await harness.runToCompletion();
      await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
      expect(details.error).toContain("exec host not allowed");
      expect(consumeRepairableCodeModeFailure(details)).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it.each([
    "earlier",
    "parked",
    "mutation-first/settles-first",
    "mutation-first/settles-last",
    "denial-first/settles-first",
    "denial-first/settles-last",
    "late-settlement",
  ] as const)("retains real whole-cell mutation history: %s", async (order) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-mode-host-marker-"));
    const marker = path.join(dir, "mutation.txt");
    const mutated = createDeferred();
    const denied = createDeferred();
    const releaseLateMutation = createDeferred();
    const lateMutationFinished = createDeferred();
    const dispatchOrder: string[] = [];
    const settlementOrder: string[] = [];
    const runBridge = codeModeBridge.runBridgeRequest;
    vi.spyOn(codeModeBridge, "runBridgeRequest").mockImplementation(async (params) => {
      const name = String(params.request.args[0]);
      dispatchOrder.push(name);
      const settled = await runBridge(params);
      settlementOrder.push(name);
      if (name === "record_mutation") {
        mutated.resolve();
      }
      if (name === "exec") {
        denied.resolve();
      }
      return settled;
    });
    const mutationFirstSettlement = order.endsWith("settles-first");
    const parallel = order.includes("/");
    installBefore(async (event) => {
      if (event.toolName === "exec" && parallel && mutationFirstSettlement) {
        await mutated.promise;
      }
    });
    const harness = createHostHarness({
      name: `mutation-${order.replaceAll("/", "-")}`,
    });
    const mutation = pluginToolWithExecute(
      "record_mutation",
      "Append one mutation marker",
      async () => {
        if (order === "late-settlement") {
          await releaseLateMutation.promise;
        }
        if (parallel && !mutationFirstSettlement) {
          await denied.promise;
        }
        await fs.appendFile(marker, "applied\n");
        lateMutationFinished.resolve();
        return jsonResult({ applied: true });
      },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, harness.shell, mutation] });
    try {
      const deny = deniedCode.replace("return await ", "").replace(/;$/, "");
      const expressions = order.startsWith("denial-first")
        ? [deny, "record_mutation({})"]
        : ["record_mutation({})", deny];
      const code =
        order === "late-settlement"
          ? `await Promise.all([record_mutation({}), ${deny}]);`
          : parallel
            ? `const results = await Promise.allSettled([${expressions.join(",")}]); throw new Error(results.find(r => r.status === "rejected").reason.message);`
            : `await record_mutation({}); ${order === "parked" ? 'await yield_control("after mutation");' : ""} ${deniedCode}`;
      let details = await harness.run(code);
      if (order === "parked") {
        expect(details.status).toBe("waiting");
        const parked = expectDefined(
          testing.activeRuns.get(String(details.runId)),
          "real parked history",
        );
        expect(parked.bridgeDispatch.potentiallyMutatingDispatches).toBeGreaterThanOrEqual(1);
        details = resultDetails(
          await expectDefined(harness.tools[1], "wait").execute("resume-denial", {
            runId: details.runId,
          }),
        );
        expect(parked.bridgeDispatch.potentiallyMutatingDispatches).toBeGreaterThanOrEqual(1);
      }
      if (order === "late-settlement") {
        expect(details.status).toBe("waiting");
        const pending = expectDefined(
          testing.activeRuns.get(String(details.runId)),
          "pending mutation",
        );
        expect(pending.bridgeDispatch.potentiallyMutatingDispatches).toBe(1);
        expect(consumeRepairableCodeModeFailure(details)).toBe(false);
        await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        releaseLateMutation.resolve();
        await lateMutationFinished.promise;
        details = resultDetails(
          await expectDefined(harness.tools[1], "wait").execute("settle-late", {
            runId: details.runId,
          }),
        );
        await vi.waitFor(() => expect(harness.subscription.getItemLifecycle().activeCount).toBe(0));
        expect(pending.bridgeDispatch.potentiallyMutatingDispatches).toBe(1);
      }
      details = await harness.complete(details);
      expect(details).toMatchObject({ status: "failed", bridgeDispatchStarted: true });
      expect(details.error).toContain("exec host not allowed");
      expect(await fs.readFile(marker, "utf8")).toBe("applied\n");
      expect(mutation.execute).toHaveBeenCalledOnce();
      if (parallel) {
        expect(dispatchOrder).toEqual(
          order.startsWith("denial-first")
            ? ["exec", "record_mutation"]
            : ["record_mutation", "exec"],
        );
        expect(settlementOrder).toEqual(
          mutationFirstSettlement ? ["record_mutation", "exec"] : ["exec", "record_mutation"],
        );
      }
      expect(consumeRepairableCodeModeFailure(details)).toBe(false);
      expect(harness.spawn).not.toHaveBeenCalled();
      expect(harness.remote).not.toHaveBeenCalled();
    } finally {
      mutated.resolve();
      denied.resolve();
      releaseLateMutation.resolve();
      harness.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["unbranded", "input-error", "security-deny"] as const)(
    "does not grant operation proof to %s failures",
    async (kind) => {
      const harness = createHostHarness({
        name: `untrusted-${kind}`,
        ...(kind === "security-deny" ? { defaults: { security: "deny" } } : {}),
      });
      if (kind === "unbranded" || kind === "input-error") {
        const error =
          kind === "input-error"
            ? new ToolInputError("exec host not allowed")
            : new Error("exec host not allowed");
        const target = pluginToolWithExecute("untrusted", "Post-start failure", async () => {
          throw error;
        });
        applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });
      }
      try {
        const details = await harness.runToCompletion(
          kind === "unbranded" || kind === "input-error"
            ? "await untrusted({});"
            : `return await exec({ command: "printf no", host: "gateway" });`,
        );
        expect(details.status).toBe("failed");
        expect(consumeRepairableCodeModeFailure(details)).toBe(false);
        expect(harness.spawn).not.toHaveBeenCalled();
        expect(harness.remote).not.toHaveBeenCalled();
      } finally {
        harness.dispose();
      }
    },
  );
  it("leaves the consumed voice grant consumed after host rejection and requires a new correction grant", async () => {
    const harness = createHostHarness({ name: "voice-denial" });
    const voiceSessionId = "host-denial-voice";
    const binding = { agentId: "main", voiceSessionId, sessionKey: harness.sessionKey };
    vi.spyOn(clientVoiceSession, "resolveClientVoiceRunBinding").mockImplementation((runId) =>
      runId === harness.runId ? binding : undefined,
    );
    vi.spyOn(clientVoiceSession, "isClientVoiceSessionConfirmable").mockReturnValue(true);
    // Explicit yieldMs keeps the granted final shape identical to the nested call.
    const args = { command: "printf voice-denied", host: "node", yieldMs: 1000 };
    const policy = {
      agentId: "main",
      voiceSessionId,
      runId: harness.runId,
      toolName: "exec",
      toolParams: args,
      isConfirmable: () => true,
    };
    const now = Date.now();
    const challenge = checkClientVoiceToolConfirmationPolicy({ ...policy, now });
    expect(challenge.allowed).toBe(false);
    if (challenge.allowed) {
      throw new Error("voice challenge expected");
    }
    const confirmationId = expectDefined(
      challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1],
      "voice challenge id",
    );
    noteClientVoiceConfirmationUtterance({
      agentId: "main",
      voiceSessionId,
      text: "yes",
      timestamp: now + 1,
    });
    const grant = authorizeClientVoiceConfirmation({
      agentId: "main",
      voiceSessionId,
      confirmationId,
      now: now + 2,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: harness.runId });
    try {
      expect(checkClientVoiceToolConfirmationPolicy(policy).allowed).toBe(true);
      const denied = await harness.runToCompletion(`return await exec(${JSON.stringify(args)});`);
      expect(denied.error).toContain("exec host not allowed");
      expect(consumeRepairableCodeModeFailure(denied)).toBe(true);
      expect(checkClientVoiceToolConfirmationPolicy(policy).allowed).toBe(false);
      for (const input of [args, { ...args, host: "gateway" }]) {
        const blocked = await harness.runToCompletion(
          `return await exec(${JSON.stringify(input)});`,
        );
        expect(blocked).toMatchObject({
          status: "completed",
          value: { status: "blocked", deniedReason: "client-voice-confirmation" },
        });
        expect(JSON.stringify(blocked.value)).toContain("VOICE_CONFIRMATION_REQUIRED");
        expect(consumeRepairableCodeModeFailure(blocked)).toBe(false);
      }
      expect(harness.spawn).not.toHaveBeenCalled();
      expect(harness.remote).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      resetClientVoiceConfirmationStateForTest();
    }
  });
  it.each(["copy", "json", "reuse"] as const)(
    "does not transfer a settled object's proof through %s",
    async (mode) => {
      const harness = createHostHarness({ name: `settled-${mode}` });
      const runBridge = codeModeBridge.runBridgeRequest;
      let first: Awaited<ReturnType<typeof runBridge>> | undefined;
      vi.spyOn(codeModeBridge, "runBridgeRequest").mockImplementation(async (params) => {
        const settled = await runBridge(params);
        if (mode === "reuse") {
          if (first) {
            return first;
          }
          first = settled;
          return settled;
        }
        first = settled;
        const serialized = JSON.stringify(settled);
        return mode === "json" ? JSON.parse(serialized) : { ...settled };
      });
      try {
        const details = await harness.runToCompletion();
        expect(details.error).toContain("exec host not allowed");
        expect(consumeRepairableCodeModeFailure(details)).toBe(mode === "reuse");
        if (mode === "reuse") {
          const reused = await harness.runToCompletion();
          expect(consumeRepairableCodeModeFailure(reused)).toBe(false);
        } else {
          expect(consumeTrustedToolNoStartError(first)).toBe(true);
        }
        expect(consumeTrustedToolNoStartError(first)).toBe(false);
        expect(harness.spawn).not.toHaveBeenCalled();
      } finally {
        harness.dispose();
      }
    },
  );
});
