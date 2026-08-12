import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createOpenClawCodingTools: vi.fn(),
}));

vi.mock("../../agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../../../plugins/provider-model-compat.js", () => ({
  extractModelCompat: vi.fn(() => ({})),
}));

vi.mock("../../conversation-capability-profile.js", () => ({
  resolveConversationCapabilityProfile: vi.fn(() => ({
    policy: { explicitToolOverrideAllowlist: undefined },
  })),
}));

vi.mock("../../local-model-lean.js", () => ({
  isLocalModelLeanEnabled: vi.fn(() => false),
  resolveLocalModelLeanPreserveToolNames: vi.fn(() => []),
}));

vi.mock("../../model-auth.js", () => ({
  resolveModelAuthMode: vi.fn(() => undefined),
}));

vi.mock("../../model-tool-support.js", () => ({
  supportsModelTools: vi.fn(() => true),
}));

vi.mock("../../tool-surface-plan.js", () => ({
  resolveAgentToolSurfacePlan: vi.fn(({ config }: { config: unknown }) => ({
    codeModeControlsEnabled: false,
    toolSearchConfig: undefined,
    toolSearchControlsEnabled: false,
    toolSearchRuntimeConfig: config,
  })),
}));

vi.mock("./attempt-tool-run-context.js", () => ({
  buildEmbeddedAttemptToolRunContext: vi.fn(() => ({})),
}));

import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";

describe("prepareEmbeddedAttemptToolBase", () => {
  it("retains only the concrete core message and replay-safe tools for restart recovery", () => {
    const coreMessage = { name: "message" };
    const pluginMessage = { name: "message" };
    const unsafeExec = { name: "exec" };
    const safeRead = { name: "read" };
    setPluginToolMeta(pluginMessage as never, {
      pluginId: "message-shadow",
      optional: false,
    });
    mocks.createOpenClawCodingTools.mockReturnValue([
      coreMessage,
      pluginMessage,
      unsafeExec,
      safeRead,
    ]);

    const prepared = prepareEmbeddedAttemptToolBase({
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        forceRestartSafeTools: true,
        model: {},
        modelId: "test-model",
        provider: "test-provider",
        runId: "test-run",
        sessionId: "test-session",
        sessionKey: "agent:main:test",
        sourceReplyDeliveryMode: "message_tool_only",
      },
      codeModeSkills: [],
      effectiveCwd: "/tmp/workspace/cwd",
      effectiveWorkspace: "/tmp/workspace",
      markCoreToolStage: vi.fn(),
      onYield: vi.fn(),
      resolvedWorkspace: "/tmp/workspace",
      runAbortController: new AbortController(),
      runTrace: {},
      sandboxSessionKey: "agent:main:test",
      sessionAgentId: "main",
      skillUsagePaths: [],
      skillsSnapshot: undefined,
      toolSearchCatalogExecutor: vi.fn(),
    } as unknown as Parameters<typeof prepareEmbeddedAttemptToolBase>[0]);

    expect(prepared.toolsRaw).toEqual([coreMessage, safeRead]);
  });
});
