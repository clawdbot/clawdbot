import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildContextReply } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    contextTokens?: number | null;
    totalTokens?: number | null;
    totalTokensFresh?: boolean;
  },
): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized,
      channel: "forum",
      senderIsOwner: true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: options?.contextTokens ?? null,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      totalTokens: options?.totalTokens ?? 123,
      totalTokensFresh: options?.totalTokensFresh ?? true,
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 12_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 60_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            missing: false,
            rawChars: truncated ? 200_000 : 10_000,
            injectedChars: truncated ? 12_000 : 10_000,
            truncated,
          },
        ],
        skills: {
          promptChars: 10,
          entries: [{ name: "checks", blockChars: 10 }],
        },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }],
        },
      },
    },
    cfg: {},
    ctx: {},
    commandBody: "",
    commandArgs: [],
    resolvedElevatedLevel: "off",
  } as unknown as HandleCommandsParams;
}

describe("buildContextReply", () => {
  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 60,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
  });

  it("falls back to config defaults when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 12,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 60,000 chars");
    expect(result.text).not.toContain("Bootstrap max/file: ? chars");
  });

  it("shows tracked estimate and cached context delta in detail output", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8_192,
        totalTokens: 900,
      }),
    );
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): 900 tok");
    expect(result.text).toContain("Untracked provider/runtime overhead: ~645 tok");
    expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
  });

  it("shows estimate-only detail output when cached context usage is unavailable", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, {
        contextTokens: 8_192,
        totalTokens: 900,
        totalTokensFresh: false,
      }),
    );
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): unavailable");
    expect(result.text).toContain("Session tokens (cached): unknown / ctx=8,192");
    expect(result.text).not.toContain("~645 tok");
  });

  it("prefers the target session entry from sessionStore for cached context stats", async () => {
    const params = makeParams("/context detail", false, {
      contextTokens: 8_192,
      totalTokens: 111,
    });
    const sessionEntry = {
      ...params.sessionEntry,
      sessionId: params.sessionEntry?.sessionId ?? "session-main",
      updatedAt: params.sessionEntry?.updatedAt ?? 1,
      totalTokens: 111,
      totalTokensFresh: true,
      inputTokens: 100,
      outputTokens: 11,
    } satisfies SessionEntry;
    params.sessionEntry = sessionEntry;
    params.sessionStore = {
      [params.sessionKey]: {
        ...sessionEntry,
        totalTokens: 900,
        totalTokensFresh: true,
        inputTokens: 700,
        outputTokens: 200,
      },
    };

    const result = await buildContextReply(params);

    expect(result.text).toContain("Actual context usage (cached): 900 tok");
    expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
    expect(result.text).not.toContain("Actual context usage (cached): 111 tok");
  });
});
