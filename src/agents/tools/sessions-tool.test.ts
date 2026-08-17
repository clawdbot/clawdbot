import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  escapeHeavyResolved,
  expectExactResolvedAcknowledgement,
  expectOmittedResolvedAcknowledgement,
  expectedResolvedOmission,
} from "./sessions-tool.test-helpers.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

describe("sessions tool", () => {
  it("carries the persisted fixed-store owner for a bare patch key", async () => {
    const callGateway = vi.fn().mockResolvedValue({});
    const tool = createSessionsTool({
      agentSessionKey: "global",
      config: {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
      callGateway,
    });

    await tool.execute("owned-patch", { action: "patch", label: "Ops" });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: { key: "global", agentId: "ops", label: "Ops" },
    });
  });

  it("resolves current under the requester instead of the persisted bare-row owner", async () => {
    const requests: AgentToolGatewayRequest[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: AgentToolGatewayRequest,
    ) => {
      requests.push(request);
      return { ok: true } as T;
    };
    const tool = createSessionsTool({
      agentSessionKey: "agent:research:main",
      requesterAgentIdOverride: "research",
      config: {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
      callGateway,
    });

    await tool.execute("research-current", {
      action: "patch",
      sessionKey: "current",
      label: "Research",
    });

    expect(requests).toContainEqual({
      method: "sessions.patch",
      params: { key: "agent:research:main", label: "Research" },
    });
    expect(requests.some((request) => request.method === "sessions.resolve")).toBe(false);
  });

  it.each(["patch", "reset", "delete"] as const)(
    "does not treat another agent's bare global row as self for %s",
    async (action) => {
      const requests: AgentToolGatewayRequest[] = [];
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: AgentToolGatewayRequest,
      ) => {
        requests.push(request);
        if (request.method === "sessions.resolve") {
          return { agentId: "ops", key: "global" } as T;
        }
        throw new Error(`unexpected gateway mutation: ${request.method}`);
      };
      const tool = createSessionsTool({
        agentSessionKey: "global",
        requesterAgentIdOverride: "research",
        config: {
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        },
        callGateway,
      });

      await expect(
        tool.execute(`foreign-global-${action}`, {
          action,
          sessionKey: "2fb701ef-6425-4c48-9b6f-5a170aa2477e",
          ...(action === "patch" ? { label: "Ops" } : {}),
        }),
      ).rejects.toThrow("Session status visibility is restricted");
      expect(requests).toContainEqual(expect.objectContaining({ method: "sessions.resolve" }));
      expect(
        requests.some((request) =>
          ["sessions.patch", "sessions.reset", "sessions.delete"].includes(request.method),
        ),
      ).toBe(false);
    },
  );

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
          enum: [
            "patch",
            "reset",
            "delete",
            "group_list",
            "group_set",
            "group_rename",
            "group_delete",
          ],
        },
        deleteTranscript: { type: "boolean" },
        label: { type: "string", description: expect.stringContaining("Empty string clears") },
        icon: {
          type: "string",
          description: expect.stringContaining(
            "named icon: braces, book, monitor, bot, kanban, coins",
          ),
        },
        statusNote: { type: "string", maxLength: 120 },
        attention: {
          type: "string",
          enum: ["clear", "hand", "key", "alert", "flag", "lock", "hourglass"],
        },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 120 },
        archived: { type: "boolean", description: expect.stringContaining("without deleting") },
      },
    });
    expect(tool.parameters).not.toHaveProperty("properties.message");
  });

  it("does not expose direct session creation outside controlled spawning", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(tool.execute("create-uncontrolled-session", { action: "create" })).rejects.toThrow(
      "Unknown action: create",
    );
    expect(tool.parameters).not.toHaveProperty("properties.parentSessionKey");
    expect(tool.parameters).not.toHaveProperty("properties.agentId");
    expect(tool.parameters).not.toHaveProperty("properties.fork");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("archives a visible target before write-scoped session deletion", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const lifecycleRevision = "finished-revision";
    const callGateway = vi.fn(async (request: { method: string }) =>
      request.method === "sessions.patch"
        ? { ok: true, entry: { sessionId, lifecycleRevision } }
        : { ok: true, deleted: true },
    );
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    await tool.execute("delete-session", {
      action: "delete",
      sessionKey,
      expectedSessionId: sessionId,
    });

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
        },
      ],
      [
        {
          method: "sessions.delete",
          params: {
            key: sessionKey,
            archivedOnly: true,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: lifecycleRevision,
            deleteTranscript: true,
          },
        },
      ],
    ]);
  });

  it("does not discover a lifecycle identity while deleting another session", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway,
    });

    await expect(
      tool.execute("delete-without-identity", {
        action: "delete",
        sessionKey: "agent:main:dashboard:finished",
      }),
    ).rejects.toThrow("requires a durable session identity");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("forwards an explicit transcript-preservation choice on deletion", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const callGateway = vi.fn(async (request: { method: string }) =>
      request.method === "sessions.patch"
        ? { ok: true, entry: { sessionId } }
        : { ok: true, deleted: true },
    );
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    await tool.execute("delete-preserve", {
      action: "delete",
      sessionKey,
      expectedSessionId: sessionId,
      deleteTranscript: false,
    });

    expect(callGateway).toHaveBeenLastCalledWith({
      method: "sessions.delete",
      params: {
        key: sessionKey,
        archivedOnly: true,
        expectedSessionId: sessionId,
        deleteTranscript: false,
      },
    });
  });

  it("does not delete a session when archive cannot identify its generation", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    await expect(
      tool.execute("delete-missing-generation", {
        action: "delete",
        sessionKey,
        expectedSessionId: sessionId,
      }),
    ).rejects.toThrow("archive did not return its session identity");

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        archived: true,
        expectedSessionId: sessionId,
      },
    });
  });

  it("resets another visible session through the canonical gateway method", async () => {
    const sessionKey = "agent:main:dashboard:reset-me";
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    await tool.execute("reset-session", { action: "reset", sessionKey });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.reset",
      params: {
        key: sessionKey,
        reason: "reset",
      },
    });
  });

  it.each(["delete", "reset"])("refuses to %s its currently running session", async (action) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(
      tool.execute(`self-${action}`, { action, sessionKey: "agent:main:main" }),
    ).rejects.toThrow(`Cannot ${action} the session running this tool`);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("patches its session, then reverts a failed agent-selected model", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { defaults: { model: { primary: "openai/good" } } },
      };
      await upsertSessionEntryCore(
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
      const callGateway = vi.fn(
        async (request: { method: string; params: Record<string, unknown> }) => {
          expect(request.method).toBe("sessions.patch");
          expect(isAgentSessionModelPatchOrigin()).toBe(true);
          await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
            label: request.params.label as string,
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
        },
      );
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

      expect(callGateway).toHaveBeenCalledWith({
        method: "sessions.patch",
        params: {
          key: sessionKey,
          label: "Research",
          model: "broken/bad",
        },
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
    await withTestDir({ prefix: "openclaw-sessions-tool-success-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
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
    await withTestDir({ prefix: "openclaw-sessions-tool-fallback-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
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
    await withTestDir({ prefix: "openclaw-sessions-tool-overlap-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/a" } } },
      };
      await upsertSessionEntryCore(
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
      await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
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
      await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
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
    const callGateway = vi.fn(async (request: { method: string; params: unknown }) => request);
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      callGateway: callGateway as never,
    });

    await tool.execute("list", { action: "group_list" });
    await tool.execute("set", { action: "group_set", names: ["Now", "Later"] });
    await tool.execute("rename", { action: "group_rename", name: "Now", to: "Next" });
    await tool.execute("delete", { action: "group_delete", name: "Later" });

    expect(callGateway.mock.calls).toEqual([
      [{ method: "sessions.groups.list", params: {} }],
      [{ method: "sessions.groups.put", params: { names: ["Now", "Later"] } }],
      [{ method: "sessions.groups.rename", params: { name: "Now", to: "Next" } }],
      [{ method: "sessions.groups.delete", params: { name: "Later" } }],
    ]);
    await expect(tool.execute("set-missing", { action: "group_set" })).rejects.toThrow(
      "names required",
    );
    await expect(
      tool.execute("set-invalid", { action: "group_set", names: ["Now", null] }),
    ).rejects.toThrow("names[1] required");
    expect(callGateway).toHaveBeenCalledTimes(4);
  });

  it("returns a bounded acknowledgement instead of the patched session entry", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: {
        skillsSnapshot: "s".repeat(47_469),
        sessionDiffBaseline: "b".repeat(3_665),
      },
      resolved: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
      },
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("patch-sidebar", {
      action: "patch",
      label: "Movies",
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: {
        key: "agent:main:main",
        label: "Movies",
      },
    });
    expect(result.details).toEqual({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["label"],
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toContain('"entry"');
    expect(text).not.toContain('"path"');
    expect(text).not.toContain('"resolved"');
    expect(text).not.toContain("skillsSnapshot");
    expect(text).not.toContain("sessionDiffBaseline");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(512);
  });

  it("returns authoritative resolved model and thinking metadata without the patched entry", async () => {
    const resolved = {
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", fallback: "openclaw" as const, source: "session" as const },
      thinkingLevel: "medium",
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "medium", label: "Medium" },
      ],
    };
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved,
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("patch-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toEqual({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
      resolved,
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toContain('"entry"');
    expect(text).not.toContain('"path"');
    expect(text).not.toContain("skillsSnapshot");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_024);
  });

  it("preserves the complete canonical thinking catalog through ultra", async () => {
    const thinkingLevels = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ].map((id) => ({ id, label: id }));
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      path: "/sessions/main",
      key: "agent:main:main",
      entry: {},
      resolved: { thinkingLevel: "ultra", thinkingLevels },
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("patch-ultra-thinking", {
      action: "patch",
      thinkingLevel: "ultra",
    });

    expect(result.details).toMatchObject({
      resolved: { thinkingLevel: "ultra", thinkingLevels },
    });
  });

  it("preserves long resolved identifiers and complete catalogs exactly when they fit", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved: adversarialResolved,
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("patch-adversarial-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toMatchObject({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
    });
    expectExactResolvedAcknowledgement(result, adversarialResolved);
  });

  it("omits oversized resolved metadata instead of changing authoritative identifiers", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved: escapeHeavyResolved,
    }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("patch-oversized-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toMatchObject({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
      resolvedOmitted: expectedResolvedOmission,
    });
    expectOmittedResolvedAcknowledgement(result);
  });

  it("keeps resolved model and thinking metadata when self-archive is deferred", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:subagent:archive-me";
      const sessionId = "archive-me-session";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({
        ok: true as const,
        path: storePath,
        key: sessionKey,
        entry: { skillsSnapshot: "s".repeat(47_469) },
        resolved: adversarialResolved,
      }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        const result = await admission.run(
          async () =>
            await tool.execute("patch-model-thinking-archive", {
              action: "patch",
              archived: true,
              model: "openai/luna",
              thinkingLevel: "med",
            }),
        );
        expect(result.details).toEqual({
          status: "scheduled",
          sessionKey,
          message: "Session will be archived after the current agent run finishes.",
          resolved: adversarialResolved,
        });
        expectExactResolvedAcknowledgement(result, adversarialResolved);
        expect(callGateway).toHaveBeenCalledTimes(1);
      } finally {
        admission.release();
      }

      await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(2));
      expect(callGateway).toHaveBeenNthCalledWith(1, {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          model: "openai/luna",
          thinkingLevel: "med",
          expectedSessionId: sessionId,
        },
      });
      expect(callGateway).toHaveBeenNthCalledWith(2, {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          archived: true,
          expectedSessionId: sessionId,
        },
      });
    });
  });

  it("patches and clears title, icon, status, attention, and archive state", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
      callGateway: callGateway as never,
    });

    await tool.execute("declare", {
      action: "patch",
      label: "Waiting on staging",
      icon: "🦞",
      statusNote: "Blocked: need the staging password",
      attention: "key",
      ttlMinutes: 45,
      archived: true,
    });
    await tool.execute("clear", { action: "patch", label: "", icon: "", attention: "clear" });

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: "Waiting on staging",
            icon: "🦞",
            statusNote: "Blocked: need the staging password",
            attention: "key",
            ttlMinutes: 45,
            archived: true,
            expectedSessionId: "session-main",
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: { key: "agent:main:main", label: null, icon: null, attention: null },
        },
      ],
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

  it("denies patch targets outside a non-main caller's session tree", async () => {
    const callGateway = vi.fn(async () => ({ sessions: [] }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:dashboard:caller",
      callGateway: callGateway as never,
    });

    await expect(
      tool.execute("patch-other", {
        action: "patch",
        sessionKey: "agent:main:other",
        expectedSessionId: "other-session",
        archived: true,
      }),
    ).rejects.toThrow("Session status visibility is restricted");
    expect(callGateway).not.toHaveBeenCalledWith({
      method: "sessions.patch",
      params: expect.objectContaining({ key: "agent:main:other" }),
    });
  });
});
