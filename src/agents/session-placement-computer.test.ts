import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createAdmittedHostCapabilityTestFixture } from "./harness/host-capability.test-support.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { withSessionPlacementComputer } from "./session-placement-computer.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import type { ComputerToolTransport } from "./tools/computer-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const transport: ComputerToolTransport = {
  computerUse: {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions: ["screenshot"],
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  },
  resolveNode: async () => ({ nodeId: "session-desktop" }),
  invoke: async () => {
    throw new Error("Tool construction must not invoke the desktop");
  },
};

describe.each([false, true])(
  "session placement computer tool policy (prepared: %s)",
  (prepared) => {
    it.each([
      { name: "default", tools: {}, allowed: true },
      {
        name: "additive sandbox tools",
        tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
        allowed: true,
      },
      {
        name: "explicit sandbox allow",
        tools: { sandbox: { tools: { allow: ["read"] } } },
        allowed: false,
      },
      {
        name: "explicit sandbox deny",
        tools: { sandbox: { tools: { deny: ["computer"] } } },
        allowed: false,
      },
      {
        name: "inactive sandbox allow",
        tools: { sandbox: { tools: { allow: ["read"] } } },
        sandboxed: false,
        allowed: true,
      },
      { name: "global deny", tools: { deny: ["computer"] }, allowed: false },
      { name: "coding profile", tools: { profile: "coding" as const }, allowed: false },
    ])(
      "applies $name policy to the real harness host tool surface",
      async ({ tools, allowed, sandboxed = true }) => {
        const workspaceDir = tempDirs.make("placement-computer-");
        const config: OpenClawConfig = { plugins: { enabled: false }, tools };
        const host = await createAdmittedHostCapabilityTestFixture({
          agentId: "main",
          runId: "run-computer",
          sessionId: "session-computer",
          sessionKey: "agent:main:session-computer",
          cwd: workspaceDir,
          workspaceDir,
          config,
        });
        const options = {
          agentId: "main",
          runId: "run-computer",
          sessionId: "session-computer",
          sessionKey: "agent:main:session-computer",
          workspaceDir,
          config,
          modelHasVision: true,
          sandbox: sandboxed
            ? createAgentToolsSandboxContext({
                workspaceDir,
                tools: resolveSandboxToolPolicyForAgent(config, "main"),
              })
            : undefined,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: true,
            includePluginTools: false,
          },
        };
        try {
          const ordinary = host.hostCapabilities.createToolSurface?.(options) ?? [];
          if (sandboxed) {
            expect(ordinary.some((tool) => tool.name === "computer")).toBe(false);
          }
          await withSessionPlacementComputer(
            {
              runId: "run-computer",
              agentId: "main",
              isActive: () => true,
              computerUse: transport.computerUse!,
              sandboxToolPolicy: resolveSandboxToolPolicyForAgent(config, "main", {
                containedToolNames: ["computer"],
              }),
              bind: (run) => {
                expect(run).toBe(host.admittedRunContext.operationalRunInstance);
                return transport;
              },
            },
            async () => {
              const conversationCapabilityProfile = prepared
                ? resolveConversationCapabilityProfile({
                    ...options,
                    sandboxToolPolicy: options.sandbox?.tools,
                  })
                : undefined;
              const bound =
                host.hostCapabilities.createToolSurface?.({
                  ...options,
                  conversationCapabilityProfile,
                }) ?? [];
              if (!sandboxed) {
                expect(bound.map((tool) => tool.name)).toEqual(
                  expect.arrayContaining(ordinary.map((tool) => tool.name)),
                );
              }
              const computer = bound.find((tool) => tool.name === "computer");
              expect(Boolean(computer)).toBe(allowed);
              if (computer) {
                expect(computer.parameters).not.toHaveProperty("properties.node");
                expect(computer.parameters).not.toHaveProperty("properties.gatewayUrl");
                expect(computer.description).toContain("this session's desktop");
              }
            },
          );
          await withSessionPlacementComputer(
            {
              runId: "run-computer",
              agentId: "main",
              isActive: () => true,
              computerUse: null,
              bind: () => null,
            },
            async () => {
              expect(
                host.hostCapabilities
                  .createToolSurface?.({ ...options, sandbox: undefined })
                  ?.some((tool) => tool.name === "computer"),
              ).toBe(false);
            },
          );
        } finally {
          host.closeHost();
          host.closeAdmission();
        }
      },
    );
  },
);

it("scopes placement policy to the active run and agent without binding a desktop", async () => {
  const ordinary = { allow: ["read"], deny: [] };
  const contained = { allow: ["computer"], deny: [] };
  const bind = vi.fn(() => transport);
  let active = true;
  await withSessionPlacementComputer(
    {
      runId: "placement-run",
      agentId: "main",
      isActive: () => active,
      computerUse: transport.computerUse!,
      sandboxToolPolicy: contained,
      bind,
    },
    async () => {
      const profile = (runId = "placement-run", agentId = "main") =>
        resolveConversationCapabilityProfile({ runId, agentId, sandboxToolPolicy: ordinary });
      expect(profile().policy.sandboxPolicy).toBe(contained);
      expect(profile().policy.explicitToolAllowlist).toContain("computer");
      for (const [runId, agentId] of [
        ["other-run", "main"],
        ["placement-run", "other-agent"],
      ]) {
        const projected = profile(runId, agentId);
        expect(projected.policy.sandboxPolicy).toBe(ordinary);
        expect(projected.policy.explicitToolAllowlist).not.toContain("computer");
      }
      active = false;
      expect(profile().policy.sandboxPolicy).toBe(ordinary);
      expect(profile().policy.explicitToolAllowlist).not.toContain("computer");
      expect(bind).not.toHaveBeenCalled();
    },
  );
});
