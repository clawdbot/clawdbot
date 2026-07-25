import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import { testing as sessionsResolutionTesting } from "./sessions-resolution.test-support.js";
import { createSessionsTool } from "./sessions-tool.js";

describe("sessions tool", () => {
  afterEach(() => {
    sessionsResolutionTesting.setDepsForTest();
  });

  it("uses the core owner gate", () => {
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("sessions");
  });

  it("cannot patch an incognito session through the cross-session tool", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: sessionKey,
      config: {},
      callGateway,
    });

    await expect(
      tool.execute("incognito-patch", { action: "patch", label: "private" }),
    ).rejects.toThrow("Session not visible from session tools");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("advertises the full model-visible sidebar presence contract", () => {
    const tool = createSessionsTool({ agentSessionKey: "agent:main:main", callGateway: vi.fn() });
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["patch", "group_list", "group_set", "group_rename", "group_delete"],
        },
        label: { type: "string", description: expect.stringContaining("Empty string clears") },
        statusNote: { type: "string", maxLength: 120 },
        attention: {
          type: "string",
          enum: ["clear", "hand", "key", "alert", "flag", "lock", "hourglass"],
        },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 120 },
        archived: { type: "boolean", description: expect.stringContaining("without deleting") },
      },
    });
  });

  it("patches its session, then reverts a failed agent-selected model", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { defaults: { model: { primary: "openai/good" } } },
      };
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "good",
          modelProvider: "openai",
          modelOverride: "good",
          providerOverride: "openai",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "primary",
          authProfileOverride: "good-profile",
          authProfileOverrideSource: "user",
          thinkingLevel: "high",
        },
      );
      const callGateway = vi.fn(async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe("sessions.patch");
        expect(isAgentSessionModelPatchOrigin()).toBe(true);
        await patchSessionEntry({ agentId: "main", sessionKey, storePath }, () => ({
          label: params.label as string,
          model: "bad",
          modelProvider: "broken",
          modelOverride: "bad",
          providerOverride: "broken",
          modelOverrideSource: "user",
          modelOverrideFallbackOriginProvider: undefined,
          modelOverrideFallbackOriginModel: undefined,
          authProfileOverride: "bad-profile",
          authProfileOverrideSource: "user",
          thinkingLevel: "low",
          modelFallback: {
            prevModel: "good",
            prevProvider: "openai",
            prevModelOverride: "good",
            prevProviderOverride: "openai",
            prevModelOverrideSource: "auto",
            prevModelOverrideFallbackOriginProvider: "openai",
            prevModelOverrideFallbackOriginModel: "primary",
            prevAuthProfileOverride: "good-profile",
            prevAuthProfileOverrideSource: "user",
            prevThinkingLevel: "high",
            ts: Date.now(),
            source: "agent-patch",
          },
        }));
        return { ok: true };
      });
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        config: cfg,
        callGateway: callGateway as never,
      });
      const currentRunGuard = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });

      await tool.execute("patch-model", {
        action: "patch",
        label: "Research",
        model: "broken/bad",
      });

      expect(callGateway).toHaveBeenCalledWith("sessions.patch", {
        key: sessionKey,
        label: "Research",
        model: "broken/bad",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        label: "Research",
        modelFallback: {
          prevModel: "good",
          prevProvider: "openai",
          prevModelOverrideSource: "auto",
          prevModelOverrideFallbackOriginProvider: "openai",
          prevModelOverrideFallbackOriginModel: "primary",
          prevAuthProfileOverride: "good-profile",
          prevThinkingLevel: "high",
          source: "agent-patch",
        },
      });
      await currentRunGuard.finish(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toHaveProperty(
        "modelFallback",
      );

      const runGuard = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await runGuard.fail({ status: 404, message: "No endpoints found for broken/bad." });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "good",
        modelProvider: "openai",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "primary",
        authProfileOverride: "good-profile",
        thinkingLevel: "high",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-main",
        sessionKey,
        storePath,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            customType: "openclaw.system-note",
            content: "System note: model broken/bad failed; reverted to openai/good.",
          }),
        }),
      );
    });
  });

  it("clears the model fallback marker after a successful run", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-success-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          modelFallback: {
            prevModel: "good",
            prevProvider: "openai",
            ts: 1,
            source: "agent-patch",
          },
        },
      );

      await createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      }).finish(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });

  it("denies model patches without in-process gateway context", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
      hasInProcessGatewayContext: () => false,
    });

    const result = await tool.execute("patch-model", {
      action: "patch",
      model: "openai/gpt-5.4",
    });

    expect(result.details).toEqual({
      status: "forbidden",
      error: "Model patch needs in-process gateway.",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reverts when the patched model fails but a fallback completes the run", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-fallback-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "bad",
          modelProvider: "broken",
          modelOverride: "bad",
          providerOverride: "broken",
          modelFallback: {
            prevModel: "good",
            prevProvider: "openai",
            ts: 1,
            source: "agent-patch",
          },
        },
      );
      const runGuard = createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      });

      const needsRevert = runGuard.captureFallbackFailure([
        {
          error: "No endpoints found for broken/bad.",
          reason: "model_not_found",
        },
        { error: "Fallback context overflow.", reason: "context_overflow" },
      ]);
      await runGuard.finish(!needsRevert);

      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "good",
        modelProvider: "openai",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });

  it("promotes the newest validated model across overlapping patches", async () => {
    await withTempDir({ prefix: "openclaw-sessions-tool-overlap-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/a" } } },
      };
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "b",
          modelProvider: "openai",
          modelOverride: "b",
          providerOverride: "openai",
          modelFallback: {
            prevModel: "a",
            prevProvider: "openai",
            ts: 10,
            source: "agent-patch",
          },
        },
      );
      const runB = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntry({ agentId: "main", sessionKey, storePath }, () => ({
        model: "c",
        modelOverride: "c",
        modelFallback: {
          prevModel: "a",
          prevProvider: "openai",
          ts: 20,
          source: "agent-patch",
        },
      }));
      const runC = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntry({ agentId: "main", sessionKey, storePath }, () => ({
        model: "d",
        modelOverride: "d",
        modelFallback: {
          prevModel: "a",
          prevProvider: "openai",
          ts: 30,
          source: "agent-patch",
        },
      }));
      const runD = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });

      await runC.finish(true);
      await runB.finish(true);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.modelFallback,
      ).toMatchObject({
        prevModel: "c",
        prevProvider: "openai",
        lastValidatedPatchTs: 20,
        ts: 30,
      });

      await runD.fail({ status: 404, message: "No endpoints found for openai/d." });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "c",
        modelProvider: "openai",
        modelOverride: "c",
        providerOverride: "openai",
      });
    });
  });

  it("routes group actions to existing gateway methods", async () => {
    const callGateway = vi.fn(async (method: string, params: Record<string, unknown>) => ({
      method,
      params,
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      callGateway: callGateway as never,
    });

    await tool.execute("list", { action: "group_list" });
    await tool.execute("set", { action: "group_set", names: ["Now", "Later"] });
    await tool.execute("rename", { action: "group_rename", name: "Now", to: "Next" });
    await tool.execute("delete", { action: "group_delete", name: "Later" });

    expect(callGateway.mock.calls).toEqual([
      ["sessions.groups.list", {}],
      ["sessions.groups.put", { names: ["Now", "Later"] }],
      ["sessions.groups.rename", { name: "Now", to: "Next" }],
      ["sessions.groups.delete", { name: "Later" }],
    ]);
    await expect(tool.execute("set-missing", { action: "group_set" })).rejects.toThrow(
      "names required",
    );
    await expect(
      tool.execute("set-invalid", { action: "group_set", names: ["Now", null] }),
    ).rejects.toThrow("names[1] required");
    expect(callGateway).toHaveBeenCalledTimes(4);
  });

  it("patches and clears a sidebar icon", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    await tool.execute("patch-icon", { action: "patch", icon: "  name:lobster  " });
    await tool.execute("clear-icon", { action: "patch", icon: "" });

    expect(callGateway.mock.calls).toEqual([
      ["sessions.patch", { key: "agent:main:main", icon: "name:lobster" }],
      ["sessions.patch", { key: "agent:main:main", icon: null }],
    ]);
  });

  it("patches and clears title, status, attention, and archive state", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    await tool.execute("declare", {
      action: "patch",
      label: "Waiting on staging",
      statusNote: "Blocked: need the staging password",
      attention: "key",
      ttlMinutes: 45,
      archived: true,
    });
    await tool.execute("clear", { action: "patch", label: "", attention: "clear" });

    expect(callGateway.mock.calls).toEqual([
      [
        "sessions.patch",
        {
          key: "agent:main:main",
          label: "Waiting on staging",
          statusNote: "Blocked: need the staging password",
          attention: "key",
          ttlMinutes: 45,
          archived: true,
        },
      ],
      ["sessions.patch", { key: "agent:main:main", label: null, attention: null }],
    ]);
  });

  it("rejects an empty patch", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(tool.execute("patch-empty", { action: "patch" })).rejects.toThrow(
      "Patch setting required",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("denies patch targets outside the caller session tree", async () => {
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(async () => ({ sessions: [] })) as never,
    });
    const callGateway = vi.fn();
    const tool = createSessionsTool({ agentSessionKey: "agent:main:main", callGateway });

    await expect(
      tool.execute("patch-other", {
        action: "patch",
        sessionKey: "agent:main:other",
        archived: true,
      }),
    ).rejects.toThrow("Session status visibility is restricted");
    expect(callGateway).not.toHaveBeenCalled();
  });
});
