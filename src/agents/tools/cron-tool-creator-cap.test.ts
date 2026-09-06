import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { mergeCronPayload } from "../../cron/service/payload-merge.js";
import type { CronPayloadPatch } from "../../cron/types.js";
import { createCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "./common.js";
import {
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
  planCronJobUpdatePatch,
  replaceWithEffectiveCronCreatorToolAllowlist,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import type { CronCreatorToolAllowlistEntry } from "./cron-tool.types.js";

function testTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

function gatewayExecAlias(execTool: AnyAgentTool, ask?: "always"): AnyAgentTool {
  return createCronScheduledToolProjection(execTool, () => {}, "exec", {
    kind: "exec",
    name: "gateway_exec",
    description: "Gateway exec alias",
    followupText: "Use gateway_process for follow-up.",
    ...(ask ? { ask } : {}),
  });
}

type CronJobUpdatePatchPlan = ReturnType<typeof planCronJobUpdatePatch>;

function readReadyPatch(plan: CronJobUpdatePatchPlan): Record<string, unknown> {
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") {
    throw new Error("expected a ready cron update patch");
  }
  return plan.patch;
}

describe("cron tool creator cap", () => {
  it("caps trigger-script creates without changing transport-only jobs", () => {
    const triggerJob = {
      trigger: { script: "return true" },
      payload: { kind: "systemEvent", text: "wake" },
    };
    const plainJob = {
      payload: { kind: "systemEvent", text: "wake" },
    };

    capCronJobToolsAllowOnCreate(triggerJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(plainJob, ["read", "cron"]);

    // Legacy "cron" creator allowlists normalize to the canonical tool id.
    expect(triggerJob.payload).toEqual({
      kind: "systemEvent",
      text: "wake",
      toolsAllow: ["read", "automations"],
      toolsAllowIsDefault: true,
    });
    expect(plainJob.payload).toEqual({ kind: "systemEvent", text: "wake" });
  });

  it("caps explicit updates without loading the current job", () => {
    const input = {
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    };

    const patch = readReadyPatch(
      planCronJobUpdatePatch({
        patch: input,
        creatorToolAllowlist: ["read", "cron"],
      }),
    );

    expect(patch).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(input).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    });
  });

  it("preserves non-policy patches without loading or synthesizing authority", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "ready", patch: { enabled: false } });
  });

  it("requests current state before deriving an implicit cap for a payload edit", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "needs-current-job" });
  });

  it("preserves explicit narrower and default caps through canonical payload merge", () => {
    const storedNarrowerPayload = {
      kind: "agentTurn" as const,
      message: "work",
      toolsAllow: ["read"],
    };
    const narrower = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "exec", "cron"],
        currentJob: { payload: storedNarrowerPayload },
      }),
    );
    const storedDefault = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "cron"],
        currentJob: {
          payload: {
            kind: "agentTurn",
            message: "work",
            toolsAllow: ["read"],
            toolsAllowIsDefault: true,
          },
        },
      }),
    );

    expect(narrower).toEqual({ payload: { kind: "agentTurn", message: "updated" } });
    expect(mergeCronPayload(storedNarrowerPayload, narrower.payload as CronPayloadPatch)).toEqual({
      kind: "agentTurn",
      message: "updated",
      toolsAllow: ["read"],
    });
    expect(storedDefault).toEqual({ payload: { kind: "agentTurn", message: "updated" } });
    expect(
      mergeCronPayload(
        {
          kind: "agentTurn",
          message: "work",
          toolsAllow: ["read"],
          toolsAllowIsDefault: true,
        },
        storedDefault.payload as CronPayloadPatch,
      ),
    ).toEqual({
      kind: "agentTurn",
      message: "updated",
      toolsAllow: ["read"],
      toolsAllowIsDefault: true,
    });
  });

  it("inherits kind for kind-less patches independently of creator policy", () => {
    const patch = { payload: { model: null } };
    expect(
      planCronJobUpdatePatch({
        patch,
        creatorToolAllowlist: undefined,
      }),
    ).toEqual({ kind: "needs-current-job" });

    expect(
      readReadyPatch(
        planCronJobUpdatePatch({
          patch,
          creatorToolAllowlist: undefined,
          currentJob: { payload: { kind: "agentTurn", message: "work" } },
        }),
      ),
    ).toEqual({ payload: { kind: "agentTurn", model: null } });
  });

  it("captures a host-created gateway alias under its canonical exec identity", () => {
    const alias = gatewayExecAlias(testTool("exec"), "always");
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [alias, testTool("read")]);

    expect(target).toEqual([
      {
        name: "exec",
        aliasName: "gateway_exec",
        execTarget: { host: "gateway", ask: "always" },
      },
      { name: "read" },
    ]);
    expect(resolveCronCreatorExecToolTarget(target)).toEqual({
      host: "gateway",
      ask: "always",
    });
  });

  it("captures an unregistered same-name tool literally, never as shell authority", () => {
    const colliding = testTool("gateway_exec");
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [colliding]);

    expect(target).toEqual([{ name: "gateway_exec" }]);
    expect(resolveCronCreatorExecToolTarget(target)).toBeUndefined();
  });

  it("drops the restrict-only pin when a direct unpinned exec grant also exists", () => {
    const execTool = testTool("exec");
    const alias = gatewayExecAlias(testTool("exec"));
    const aliasFirst: CronCreatorToolAllowlistEntry[] = [];
    const directFirst: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(aliasFirst, [alias, execTool]);
    replaceWithEffectiveCronCreatorToolAllowlist(directFirst, [execTool, alias]);

    expect(aliasFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
    expect(directFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
    expect(resolveCronCreatorExecToolTarget(aliasFirst)).toBeUndefined();
    expect(resolveCronCreatorExecToolTarget(directFirst)).toBeUndefined();
  });

  it("keeps a guarded gateway exec pin when the native harness also owns shell", () => {
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(
      target,
      [gatewayExecAlias(testTool("exec"), "always")],
      undefined,
      { canonicalToolNames: ["exec", "process"] },
    );

    expect(target).toEqual([
      { name: "exec", aliasName: "gateway_exec", execTarget: { host: "gateway", ask: "always" } },
      { name: "process" },
    ]);
    expect(resolveCronCreatorExecToolTarget(target)).toEqual({ host: "gateway", ask: "always" });
  });

  it("pins native shell authority to the gateway host only when the caller vouches for it", () => {
    const pinned: CronCreatorToolAllowlistEntry[] = [];
    const unpinned: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(pinned, [testTool("read")], undefined, {
      canonicalToolNames: ["exec", "process", "read", "web_fetch"],
      nativeExecTarget: { host: "gateway" },
    });
    // A harness whose shell may run remotely (for example Codex on a node or
    // sandbox placement) records plain exec so host routing stays configurable.
    replaceWithEffectiveCronCreatorToolAllowlist(unpinned, [testTool("read")], undefined, {
      canonicalToolNames: ["exec", "process"],
    });

    expect(pinned).toEqual([
      { name: "read" },
      { name: "exec", execTarget: { host: "gateway" } },
      { name: "process" },
      { name: "web_fetch" },
    ]);
    expect(resolveCronCreatorExecToolTarget(pinned)).toEqual({ host: "gateway" });
    expect(unpinned).toEqual([{ name: "read" }, { name: "exec" }, { name: "process" }]);
    expect(resolveCronCreatorExecToolTarget(unpinned)).toBeUndefined();
  });

  it("never pins a direct unpinned exec grant because the native shell also exists", () => {
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [testTool("exec")], undefined, {
      canonicalToolNames: ["exec"],
      nativeExecTarget: { host: "gateway" },
    });

    expect(target).toEqual([{ name: "exec" }]);
    expect(resolveCronCreatorExecToolTarget(target)).toBeUndefined();
  });

  it("rejects a backend-projected name outside the native capability vocabulary", () => {
    for (const rejected of [
      "Bash",
      "READ",
      " exec ",
      "apply-patch",
      "gateway_exec",
      "browser",
      "",
      "*",
    ]) {
      const target: CronCreatorToolAllowlistEntry[] = [];
      expect(() =>
        replaceWithEffectiveCronCreatorToolAllowlist(target, [testTool("read")], undefined, {
          canonicalToolNames: ["read", rejected],
        }),
      ).toThrow(/non-canonical native capability/);
    }
  });

  it("keeps only restrictions shared by duplicate gateway aliases", () => {
    const guarded = gatewayExecAlias(testTool("exec"), "always");
    const unguarded = gatewayExecAlias(testTool("exec"));
    const guardedFirst: CronCreatorToolAllowlistEntry[] = [];
    const unguardedFirst: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(guardedFirst, [guarded, unguarded]);
    replaceWithEffectiveCronCreatorToolAllowlist(unguardedFirst, [unguarded, guarded]);

    expect(resolveCronCreatorExecToolTarget(guardedFirst)).toEqual({ host: "gateway" });
    expect(resolveCronCreatorExecToolTarget(unguardedFirst)).toEqual({ host: "gateway" });
  });

  it("caps explicit alias-name requests to the canonical persisted tool id", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator: CronCreatorToolAllowlistEntry[] = [];
    replaceWithEffectiveCronCreatorToolAllowlist(creator, [alias, testTool("read")]);

    for (const requested of [["gateway_exec"], ["exec"], ["gateway_exec", "read"]]) {
      const job = {
        trigger: { script: "return { fire: false }" },
        payload: { kind: "systemEvent", text: "wake", toolsAllow: [...requested] },
      };
      capCronJobToolsAllowOnCreate(job, creator);
      const expected = requested.includes("read") ? ["exec", "read"] : ["exec"];
      expect(job.payload.toolsAllow).toEqual(expected);
    }

    const unrelated = {
      trigger: { script: "return { fire: false }" },
      payload: { kind: "systemEvent", text: "wake", toolsAllow: ["write"] },
    };
    capCronJobToolsAllowOnCreate(unrelated, creator);
    expect(unrelated.payload.toolsAllow).toEqual([]);
  });

  it("treats an alias-name finite request as already covered by creator authority", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator: CronCreatorToolAllowlistEntry[] = [];
    replaceWithEffectiveCronCreatorToolAllowlist(creator, [alias]);

    const job = {
      trigger: { script: "return { fire: false }" },
      payload: { kind: "systemEvent", text: "wake", toolsAllow: ["gateway_exec"] },
    };
    expect(cronCreateRequiresCreatorAuthority(job, creator)).toBe(false);
    expect(
      cronCreateRequiresCreatorAuthority(
        {
          trigger: { script: "return { fire: false }" },
          payload: { kind: "systemEvent", text: "wake", toolsAllow: ["exec", "browser"] },
        },
        creator,
      ),
    ).toBe(true);
  });
});
