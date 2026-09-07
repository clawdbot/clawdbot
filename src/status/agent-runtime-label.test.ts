import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

type LabelArgs = Parameters<typeof resolveAgentRuntimeLabel>[0];

const classifyCliProvider = (provider: string) =>
  provider === "claude-cli" || provider === "google-gemini-cli";

const acpMeta = (agent: string, backend: string): SessionAcpMeta => ({
  agent,
  backend,
  runtimeSessionName: `${agent}-session`,
  mode: "persistent",
  state: "idle",
  lastActivityAt: 0,
});

describe("resolveAgentRuntimeLabel", () => {
  it.each<{ name: string; args: LabelArgs; expected: string }>([
    {
      name: "ACP agent and backend outrank the resolved harness",
      args: {
        sessionEntry: { acp: acpMeta("gemini", "acpx"), agentHarnessId: "codex" },
        resolvedHarness: "openclaw",
      },
      expected: "gemini (acp/acpx)",
    },
    {
      name: "ACP agent without a backend still owns the label",
      args: { sessionEntry: { acp: acpMeta("gemini", "") } },
      expected: "gemini (acp)",
    },
    {
      name: "a resolved harness maps to its operator label",
      args: { resolvedHarness: "codex" },
      expected: "OpenAI Codex",
    },
    {
      name: "an unmapped resolved harness falls back to its sanitized id",
      args: { resolvedHarness: "claude-bridge" },
      expected: "claude-bridge",
    },
    {
      name: "auto defers to the CLI provider fallback",
      args: {
        sessionEntry: { modelProvider: "claude-cli" },
        resolvedHarness: "auto",
        classifyCliProvider,
      },
      expected: "Claude CLI",
    },
    {
      name: "default defers to the CLI provider fallback",
      args: {
        resolvedHarness: "default",
        fallbackProvider: "google-gemini-cli",
        classifyCliProvider,
      },
      expected: "Gemini CLI",
    },
    {
      name: "an unmapped CLI provider is marked as a CLI runtime",
      args: { fallbackProvider: "vendor-cli", classifyCliProvider: () => true },
      expected: "vendor-cli (cli)",
    },
    {
      name: "a non-CLI provider resolves to the built-in runtime",
      args: { fallbackProvider: "anthropic", classifyCliProvider: () => false },
      expected: "OpenClaw Default",
    },
  ])("$name", ({ args, expected }) => {
    expect(resolveAgentRuntimeLabel(args)).toBe(expected);
  });

  it("names the persisted harness pin when it disagrees with the resolved harness", () => {
    expect(
      resolveAgentRuntimeLabel({
        sessionEntry: {
          agentHarnessId: "codex",
          modelProvider: "anthropic",
          modelSelectionLocked: true,
        },
        resolvedHarness: "claude-bridge",
        fallbackProvider: "anthropic",
        classifyCliProvider: () => false,
      }),
    ).toBe("claude-bridge (session pin: OpenAI Codex)");
  });

  it.each<{ name: string; args: LabelArgs; expected: string }>([
    {
      name: "a pin matching the resolved harness adds no note",
      args: { sessionEntry: { agentHarnessId: "codex" }, resolvedHarness: "codex" },
      expected: "OpenAI Codex",
    },
    {
      name: "a retired pin alias is compared against its current runtime id",
      args: { sessionEntry: { agentHarnessId: "codex-app-server" }, resolvedHarness: "codex" },
      expected: "OpenAI Codex",
    },
    {
      name: "a retired codex-cli pin is not reported as a transition to codex",
      args: { sessionEntry: { agentHarnessId: "codex-cli" }, resolvedHarness: "codex" },
      expected: "OpenAI Codex",
    },
    {
      name: "a locked retired codex-cli pin is not reported as a session pin either",
      args: {
        sessionEntry: { agentHarnessId: "codex-cli", modelSelectionLocked: true },
        resolvedHarness: "codex",
      },
      expected: "OpenAI Codex",
    },
    {
      name: "a plugin-owned locked harness remains previous runtime history",
      args: {
        sessionEntry: {
          agentHarnessId: "openclaw",
          modelSelectionLocked: true,
          pluginOwnerId: "model-owner",
        },
        resolvedHarness: "codex",
      },
      expected: "OpenAI Codex (previous runtime: OpenClaw Default)",
    },
    {
      name: "a retired codex-cli pin still reports a real transition",
      args: { sessionEntry: { agentHarnessId: "codex-cli" }, resolvedHarness: "claude-cli" },
      expected: "Claude CLI (previous runtime: OpenAI Codex)",
    },
    {
      name: "an auto pin carries no runtime ownership to report",
      args: { sessionEntry: { agentHarnessId: "auto" }, resolvedHarness: "codex" },
      expected: "OpenAI Codex",
    },
    {
      name: "a pin diverging from the CLI provider fallback is reported",
      args: {
        sessionEntry: { agentHarnessId: "codex", modelProvider: "claude-cli" },
        classifyCliProvider,
      },
      expected: "Claude CLI (previous runtime: OpenAI Codex)",
    },
    {
      name: "a pin diverging from the built-in runtime fallback is reported",
      args: {
        sessionEntry: { agentHarnessId: "codex" },
        fallbackProvider: "anthropic",
        classifyCliProvider: () => false,
      },
      expected: "OpenClaw Default (previous runtime: OpenAI Codex)",
    },
    {
      name: "an unmapped pin is reported by its sanitized id",
      args: { sessionEntry: { agentHarnessId: "custom-harness" }, resolvedHarness: "codex" },
      expected: "OpenAI Codex (previous runtime: custom-harness)",
    },
  ])("$name", ({ args, expected }) => {
    expect(resolveAgentRuntimeLabel(args)).toBe(expected);
  });
});
