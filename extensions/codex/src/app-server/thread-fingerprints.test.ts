import { describe, expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec, JsonObject } from "./protocol.js";
import {
  codexDynamicToolsFingerprint,
  fingerprintCodexThreadConfig,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";

describe("codexDynamicToolsFingerprint", () => {
  const createMessageTool = (description: string, channelDescription: string) =>
    ({
      type: "function",
      name: "message",
      description,
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: channelDescription,
          },
        },
      },
    }) satisfies CodexDynamicToolFunctionSpec;

  it("changes when model-visible dynamic tool descriptions change", () => {
    expect(
      codexDynamicToolsFingerprint([
        createMessageTool("Send to the current Slack thread.", "Current channel."),
      ]),
    ).not.toBe(
      codexDynamicToolsFingerprint([
        createMessageTool("Send to the current Discord channel.", "Current channel."),
      ]),
    );
  });

  it("changes when model-visible input schema descriptions change", () => {
    expect(
      codexDynamicToolsFingerprint([createMessageTool("Send a message.", "Current Slack thread.")]),
    ).not.toBe(
      codexDynamicToolsFingerprint([
        createMessageTool("Send a message.", "Current Discord channel."),
      ]),
    );
  });

  it("remains stable when tools and schema properties are reordered", () => {
    const message = createMessageTool("Send a message.", "Current channel.");
    const reorderedMessage: CodexDynamicToolFunctionSpec = {
      name: message.name,
      type: message.type,
      inputSchema: {
        properties: {
          channel: {
            description: "Current channel.",
            type: "string",
          },
        },
        type: "object",
      },
      description: message.description,
    };
    const search: CodexDynamicToolFunctionSpec = {
      type: "function",
      name: "search",
      description: "Search the current conversation.",
      inputSchema: { type: "object", properties: {} },
    };

    expect(codexDynamicToolsFingerprint([message, search])).toBe(
      codexDynamicToolsFingerprint([search, reorderedMessage]),
    );
  });
});

describe("fingerprintCodexThreadConfig", () => {
  const request = {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    personality: "none",
    serviceTier: "fast",
    developerInstructions: "Keep the current conversation private.",
    config: { features: { hooks: true, plugins: false } },
  };

  it("stabilizes equivalent config without exposing instructions or profile", () => {
    const fingerprint = fingerprintCodexThreadConfig(request, "openai:personal");

    expect(fingerprint).toBe(
      fingerprintCodexThreadConfig(
        { ...request, config: { features: { plugins: false, hooks: true } } },
        "openai:personal",
      ),
    );
    expect(fingerprint).not.toContain("private");
    expect(fingerprint).not.toContain("openai:personal");
  });

  it.each<{ setting: string; patch: JsonObject }>([
    { setting: "model provider", patch: { modelProvider: "custom" } },
    { setting: "requested model provider", patch: { requestedModelProvider: "custom" } },
    { setting: "native multi-agent generation", patch: { model: "gpt-5.6-luna" } },
    { setting: "named permissions profile", patch: { permissions: "read-only" } },
    { setting: "base instructions", patch: { baseInstructions: "Different base policy." } },
    { setting: "developer instructions", patch: { developerInstructions: "Different policy." } },
    { setting: "effective config", patch: { config: { features: { hooks: false } } } },
  ])("invalidates reuse when $setting changes", ({ patch }) => {
    expect(fingerprintCodexThreadConfig({ ...request, ...patch }, "openai:personal")).not.toBe(
      fingerprintCodexThreadConfig(request, "openai:personal"),
    );
  });

  it("invalidates reuse when the selected authentication profile changes", () => {
    expect(fingerprintCodexThreadConfig(request, "openai:work")).not.toBe(
      fingerprintCodexThreadConfig(request, "openai:personal"),
    );
  });

  it("invalidates reuse when the native dynamic tool catalog changes", () => {
    expect(fingerprintCodexThreadConfig(request, "openai:personal", "tools-after")).not.toBe(
      fingerprintCodexThreadConfig(request, "openai:personal", "tools-before"),
    );
  });

  it.each<{ setting: string; patch: JsonObject }>([
    { setting: "model", patch: { model: "gpt-5.6-terra" } },
    { setting: "requested model", patch: { requestedModel: null } },
    { setting: "approval policy", patch: { approvalPolicy: "on-request" } },
    { setting: "approval reviewer", patch: { approvalsReviewer: "guardian" } },
    { setting: "sandbox", patch: { sandbox: "read-only" } },
    { setting: "service tier", patch: { serviceTier: "flex" } },
    { setting: "personality", patch: { personality: "friendly" } },
    { setting: "working directory", patch: { cwd: "/other/workspace" } },
  ])("preserves the native session when turn/start changes $setting", ({ patch }) => {
    expect(fingerprintCodexThreadConfig({ ...request, ...patch }, "openai:personal")).toBe(
      fingerprintCodexThreadConfig(request, "openai:personal"),
    );
  });
});

describe("readActiveCodexTurnIdsFromResume", () => {
  it("uses the bounded initial turns page when Codex returns one", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "stale", status: "inProgress" }] },
        initialTurnsPage: {
          data: [{ id: "current", status: "inProgress" }],
        },
      }),
    ).toEqual(["current"]);
  });

  it("falls back to legacy resume turns when no page is returned", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "legacy", status: "inProgress" }] },
      }),
    ).toEqual(["legacy"]);
  });
});
