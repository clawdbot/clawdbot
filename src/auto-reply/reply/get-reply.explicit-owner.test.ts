import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { resolvePromptBuildHookResult } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/embedded-agent-runner/run/attempt-setup.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as pluginRuntime from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async ({ agentId }: { agentId?: string }) => ({
    payloads: [{ text: `${agentId} prepared` }],
    meta: { durationMs: 1 },
  })),
}));

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function createExplicitOwnerConfig() {
  state = await createOpenClawTestState({
    label: "explicit-reply",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: state.path("main-workspace") },
        work: { workspace: state.path("work-workspace") },
      },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  });
  await state.writeConfig(cfg);
  return cfg;
}

it.each(["main", "work"])(
  "resolves the explicit %s embedded workspace for a global session",
  async (agentId) => {
    const cfg = await createExplicitOwnerConfig();
    const setup = await resolveAttemptWorkspaceSandbox({
      agentId,
      config: cfg,
      sessionId: `${agentId}-global`,
      sessionKey: "global",
      workspaceDir: state!.workspaceDir,
    });
    expect(setup.sessionAgentId).toBe(agentId);
    expect(setup.sandbox).toBeNull();
  },
);

it.each(["main", "work"])(
  "consumes only %s global next-turn context during prompt preparation",
  async (agentId) => {
    const cfg = await createExplicitOwnerConfig();
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "injector", status: "loaded" }));
    vi.spyOn(pluginRuntime, "getActivePluginRegistry").mockReturnValue(registry);
    for (const owner of ["main", "work"]) {
      await replaceSessionEntry(
        { agentId: owner, sessionKey: "global" },
        {
          sessionId: `${owner}-global`,
          updatedAt: 1,
          pluginNextTurnInjections: {
            injector: [
              {
                id: owner,
                pluginId: "injector",
                text: `${owner} context`,
                placement: "prepend_context",
                createdAt: 1,
              },
            ],
          },
        },
      );
    }
    const prepare = () =>
      resolvePromptBuildHookResult({
        config: cfg,
        prompt: "hello",
        messages: [],
        hookCtx: { agentId, sessionKey: "global" },
      });
    expect((await prepare()).prependContext).toBe(`${agentId} context`);
    expect(
      loadSessionEntryReadOnly({ agentId, sessionKey: "global" })?.pluginNextTurnInjections,
    ).toBeUndefined();
    const otherAgentId = agentId === "main" ? "work" : "main";
    expect(
      loadSessionEntryReadOnly({ agentId: otherAgentId, sessionKey: "global" })
        ?.pluginNextTurnInjections?.injector,
    ).toEqual([expect.objectContaining({ text: `${otherAgentId} context` })]);
    expect((await prepare()).prependContext).toBeUndefined();
  },
);

it.each(["main", "work"])(
  "carries explicit %s ownership through full global reply preparation",
  async (agentId) => {
    const cfg = await createExplicitOwnerConfig();
    const reply = await getReplyFromConfig(
      finalizeInboundContext({
        AgentId: agentId,
        SessionKey: "global",
        Body: "hello",
        BodyForAgent: "hello",
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        CommandAuthorized: true,
      }),
      undefined,
      cfg,
    );
    expect([reply].flat()).toEqual([expect.objectContaining({ text: `${agentId} prepared` })]);
    expect(runEmbeddedAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId, sessionKey: "global" }),
    );
  },
);

it.each([
  { agentId: "main", sessionKey: "global", target: undefined, expectedOwner: "main" },
  { agentId: "work", sessionKey: "global", target: undefined, expectedOwner: "work" },
  {
    agentId: "main",
    sessionKey: "agent:main:source",
    target: "agent:work:target",
    expectedOwner: "work",
  },
])(
  "stages an ordinary attachment for $expectedOwner from $sessionKey/$target",
  async ({ agentId, sessionKey, target, expectedOwner }) => {
    const cfg = await createExplicitOwnerConfig();
    const file = state!.statePath("media", "inbound", "owner.zip");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = "PK\u0003\u0004mimetypeapplication/epub+zipcontent.opf";
    await fs.writeFile(file, bytes);
    const ctx = finalizeInboundContext({
      AgentId: agentId,
      SessionKey: sessionKey,
      CommandTargetSessionKey: target,
      CommandSource: target ? "native" : undefined,
      Body: "read this attachment",
      BodyForAgent: "read this attachment",
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      CommandAuthorized: true,
      media: [{ path: file, contentType: "application/zip" }],
    });
    const reply = await getReplyFromConfig(ctx, undefined, cfg);
    expect([reply].flat()).toEqual([
      expect.objectContaining({ text: `${expectedOwner} prepared` }),
    ]);
    expect(runEmbeddedAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: expectedOwner, sessionKey: target ?? sessionKey }),
    );
    expect(ctx.media?.[0]).toMatchObject({
      staged: true,
      workspaceDir: state!.path(`${expectedOwner}-workspace`),
    });
    expect(
      await fs.readFile(expectDefined(ctx.media?.[0]?.path, "staged attachment"), "utf8"),
    ).toBe(bytes);
  },
);
