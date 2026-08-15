import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexModelListResponse } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_APPROVAL_REQUESTER === "1";
const describeLive = LIVE ? describe : describe.skip;

afterEach(() => {
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
});

describeLive("Codex app-server approval requester real-binary bridge", () => {
  it("runs owner-gated apply_patch under default yolo without approval requests", async () => {
    await withTempDir("openclaw-codex-approval-requester-", async (root) => {
      const workspace = path.join(root, "workspace");
      const agentDir = path.join(root, "agent");
      const target = path.join(workspace, "memory", "real-binary-owner.md");
      await fs.mkdir(path.dirname(target), { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));

      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { homeScope: "user" } },
        env: {},
      });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: runtime.start,
        agentDir,
        authProfileId: null,
        timeoutMs: 120_000,
      });
      let closeHost: (() => void) | undefined;
      try {
        const listed = await client.request<CodexModelListResponse>(
          "model/list",
          { limit: 100, cursor: null, includeHidden: false },
          { timeoutMs: 60_000 },
        );
        const modelId =
          listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
        if (!modelId) {
          throw new Error("Codex model/list returned no models");
        }

        const hookRequesters: unknown[] = [];
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: async (_event, ctx) => {
                const hookContext = ctx as PluginHookToolContext;
                hookRequesters.push(hookContext.requester);
                return hookContext.requester?.senderIsOwner === true
                  ? undefined
                  : { block: true, blockReason: "owner required" };
              },
            },
          ]),
        );
        const serverRequestMethods: string[] = [];
        client.addRequestHandler((request) => {
          serverRequestMethods.push(request.method);
          return undefined;
        });
        const agentEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
        const params = {
          sessionId: "approval-requester-session",
          sessionKey: "agent:approval-requester:main",
          sessionFile: path.join(root, "session.jsonl"),
          workspaceDir: workspace,
          cwd: workspace,
          agentDir,
          provider: "codex",
          modelId,
          model: {
            id: modelId,
            name: modelId,
            provider: "codex",
            api: "openai-chatgpt-responses",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8_000,
            compat: { supportsTools: false },
          },
          prompt:
            "Use the exec tool exactly once. In its JavaScript call tools.apply_patch to create memory/real-binary-owner.md containing exactly REAL_BINARY_OWNER_OK, then reply done. Do not call apply_patch directly.",
          runId: "approval-requester-run",
          contextTokenBudget: 150_000,
          contextWindowInfo: {
            tokens: 150_000,
            referenceTokens: 200_000,
            source: "agentContextTokens",
          },
          thinkLevel: "medium",
          disableTools: false,
          config: { tools: { web: { search: { enabled: false } } } },
          timeoutMs: 180_000,
          trigger: "user",
          oneShotCliRun: true,
          senderIsOwner: true,
          authStorage: {},
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry: {},
          onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
            agentEvents.push(event);
          },
        } as unknown as EmbeddedRunAttemptParams;
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: params,
          pluginId: "codex",
        });
        params.hostCapabilities = host.capabilities;
        closeHost = host.close;

        const result = await runCodexAppServerAttempt(params, {
          bindingStore: createCodexTestBindingStore(),
          pluginConfig: { appServer: { homeScope: "user" } },
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
          clientFactory: async () => client,
        });

        expect(result.terminal.kind, JSON.stringify(result.terminal)).toBe("ok");
        expect(await fs.readFile(target, "utf8")).toBe("REAL_BINARY_OWNER_OK\n");
        expect(
          serverRequestMethods.filter((method) => method.endsWith("/requestApproval")),
        ).toEqual([]);
        expect(hookRequesters).toEqual(
          expect.arrayContaining([expect.objectContaining({ senderIsOwner: true })]),
        );
        expect(agentEvents.filter((event) => event.stream === "approval")).toEqual([]);
      } finally {
        closeHost?.();
        await client.closeAndWait();
      }
    });
  }, 240_000);
});
