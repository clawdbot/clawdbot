/** Tests context command behavior, token reporting, and generated report files. */
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { buildContextReply } from "./commands-context-report.js";
import { buildCommandContext } from "./commands-context.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { buildTestCtx } from "./test-ctx.js";

/** Tests context report command output and generated report files. */

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    contextTokens?: number | null;
    totalTokens?: number | null;
    totalTokensFresh?: boolean;
    cfg?: Record<string, unknown>;
    sessionKey?: string;
    sessionId?: string;
    sessionFile?: string;
    storePath?: string;
    agentId?: string;
    currentTurn?: NonNullable<SessionEntry["systemPromptReport"]>["currentTurn"];
  },
): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized,
      channel: "forum",
      senderIsOwner: true,
    },
    sessionKey: options?.sessionKey ?? "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: options?.contextTokens ?? null,
    storePath: options?.storePath,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.sessionFile ? { sessionFile: options.sessionFile } : {}),
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
        ...(options?.currentTurn ? { currentTurn: options.currentTurn } : {}),
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
    cfg: options?.cfg ?? {},
    agentId: options?.agentId,
    ctx: {},
    commandBody: "",
    commandArgs: [],
    resolvedElevatedLevel: "off",
  } as unknown as HandleCommandsParams;
}

async function withTranscript(
  messages: unknown[],
  run: (sessionFile: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-context-report-"));
  try {
    const sessionFile = join(dir, "session.jsonl");
    const lines = messages.map((message, index) =>
      JSON.stringify({
        id: `record-${index + 1}`,
        timestamp: new Date(index + 1).toISOString(),
        message,
      }),
    );
    await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
    await run(sessionFile, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildContextReply", () => {
  it("describes compactable transcript counts in help output", async () => {
    const result = await buildContextReply(makeParams("/context", false));
    expect(result.text).toContain(
      "/context detail (per-file + per-tool + per-skill + system prompt size + compactable transcript counts)",
    );
  });

  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 60,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
    expect(result.text).toContain("agents.list[].bootstrapMaxChars");
    expect(result.text).toContain("agents.defaults.*");
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
    expect(result.text).toContain("Bootstrap max/file: 20,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 60,000 chars");
    expect(result.text).not.toContain("Bootstrap max/file: ? chars");
  });

  it("uses the session agent profile when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
        sessionKey: "agent:scout:main",
        cfg: {
          agents: {
            defaults: {
              bootstrapMaxChars: 12_000,
              bootstrapTotalMaxChars: 60_000,
            },
            list: [
              {
                id: "scout",
                bootstrapMaxChars: 32_000,
                bootstrapTotalMaxChars: 96_000,
              },
            ],
          },
        },
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 32,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 96,000 chars");
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
    expect(result.text).toContain(
      "Compactable transcript: unavailable (no active transcript session)",
    );
    expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
  });

  it("reports compactable real conversation messages from the active transcript", async () => {
    await withTranscript(
      [
        { role: "user", content: "Please inspect the repo", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", toolName: "read", toolCallId: "call-1", args: {} }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "package.json" }],
          timestamp: 3,
          toolCallId: "call-1",
          toolName: "read",
        },
      ],
      async (sessionFile) => {
        const result = await buildContextReply(
          makeParams("/context detail", false, {
            contextTokens: 8_192,
            totalTokens: 900,
            sessionId: "session",
            sessionFile,
          }),
        );

        expect(result.text).toContain(
          "Compactable transcript: 2 real conversation message(s) / 3 transcript message(s)",
        );
        expect(result.text).not.toContain("Compaction note:");
      },
    );
  });

  it("explains when cached prompt usage has no compactable conversation messages", async () => {
    await withTranscript(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", toolName: "read", toolCallId: "call-1", args: {} }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "package.json" }],
          timestamp: 2,
          toolCallId: "call-1",
          toolName: "read",
        },
      ],
      async (sessionFile) => {
        const result = await buildContextReply(
          makeParams("/context detail", false, {
            contextTokens: 8_192,
            totalTokens: 900,
            sessionId: "session",
            sessionFile,
          }),
        );

        expect(result.text).toContain(
          "Compactable transcript: 0 real conversation message(s) / 2 transcript message(s)",
        );
        expect(result.text).toContain(
          "Compaction note: prompt/cache usage may be high even when there are no compactable conversation messages.",
        );
      },
    );
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

  it("renders context map as sensitive local PNG media", async () => {
    const result = await buildContextReply(
      makeParams("/context map", false, {
        contextTokens: 8_192,
        totalTokens: 900,
      }),
    );
    if (!result.mediaUrl) {
      throw new Error("missing context map media path");
    }
    try {
      const png = await readFile(result.mediaUrl);
      expect(result.text).toContain("Context treemap");
      expect(result.text).toContain("Source: run");
      expect(result.text).toContain("Actual cached context: 900 tok");
      expect(result.trustedLocalMedia).toBe(true);
      expect(result.sensitiveMedia).toBe(true);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(1280);
      expect(png.readUInt32BE(20)).toBe(860);
    } finally {
      await unlink(result.mediaUrl);
    }
  });

  it("includes transcript conversation size in context maps", async () => {
    await withTranscript(
      [
        { role: "user", content: "abcd", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "efghij" }], timestamp: 2 },
        {
          role: "toolResult",
          content: [{ type: "text", text: "klmno" }],
          timestamp: 3,
          toolCallId: "call-1",
          toolName: "read",
        },
      ],
      async (sessionFile) => {
        const result = await buildContextReply(
          makeParams("/context map", false, {
            contextTokens: 8_192,
            totalTokens: 900,
            sessionId: "session",
            sessionFile,
          }),
        );
        if (!result.mediaUrl) {
          throw new Error("missing context map media path");
        }
        try {
          const png = await readFile(result.mediaUrl);
          expect(result.text).toContain("Conversation: 20 chars (~5 tok)");
          expect(result.trustedLocalMedia).toBe(true);
          expect(result.sensitiveMedia).toBe(true);
          expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        } finally {
          await unlink(result.mediaUrl);
        }
      },
    );
  });

  it("counts model-only turn context but not the persisted current-turn prompt", async () => {
    const result = await buildContextReply(
      makeParams("/context map", false, {
        contextTokens: 8_192,
        totalTokens: 900,
        currentTurn: {
          kind: "room_event",
          promptChars: 11,
          runtimeContextChars: 17,
          modelOnlyPromptChars: 5,
        },
      }),
    );
    if (!result.mediaUrl) {
      throw new Error("missing context map media path");
    }
    try {
      expect(result.text).toContain("Tracked: 10,542 chars");
      expect(result.text).toContain("Conversation: 22 chars (~6 tok)");
    } finally {
      await unlink(result.mediaUrl);
    }
  });

  it("does not render context map from an estimated report", async () => {
    const params = makeParams("/context map", false);
    const report = params.sessionEntry?.systemPromptReport;
    if (!report) {
      throw new Error("missing context report");
    }
    params.sessionEntry = {
      ...params.sessionEntry,
      systemPromptReport: {
        ...report,
        source: "estimate",
      },
    } as SessionEntry;

    const result = await buildContextReply(params);

    expect(result.text).toContain("Context treemap unavailable.");
    expect(result.text).toContain("No actual run context is cached for this session yet.");
    expect(result.text).not.toContain("Source: estimate");
    expect(result.mediaUrl).toBeUndefined();
  });
});

/** Tests context command behavior and token reporting. */

describe("buildCommandContext", () => {
  it("canonicalizes registered aliases like /id to their primary command", () => {
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      From: "user",
      To: "bot",
      Body: "/id",
      RawBody: "/id",
      CommandBody: "/id",
      BodyForCommands: "/id",
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: "/id",
      commandAuthorized: true,
    });

    expect(result.commandBodyNormalized).toBe("/whoami");
  });

  it("preserves multiline soft reset tails after structural normalization", () => {
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "user",
      To: "bot",
      Body: "/reset soft\nre-read persona files",
      RawBody: "/reset soft\nre-read persona files",
      CommandBody: "/reset soft\nre-read persona files",
      BodyForCommands: "/reset soft\nre-read persona files",
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: stripStructuralPrefixes("/reset soft\nre-read persona files"),
      commandAuthorized: true,
    });

    expect(result.commandBodyNormalized).toBe("/reset soft re-read persona files");
  });

  it("preserves multiline slash skill payloads after structural normalization", () => {
    const body = "/skill demo_skill first line\nsecond line";
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "user",
      To: "bot",
      Body: body,
      RawBody: body,
      CommandBody: body,
      BodyForCommands: body,
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: stripStructuralPrefixes(body),
      commandAuthorized: true,
    });

    expect(result.commandBodyNormalized).toBe("/skill demo_skill first line\nsecond line");
  });

  it("maps explicit gateway origin into command context", () => {
    const ctx = buildTestCtx({
      Provider: "internal",
      Surface: "internal",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U123",
      SenderId: "gateway-client",
      From: undefined,
      To: undefined,
      Body: "/codex bind",
      RawBody: "/codex bind",
      CommandBody: "/codex bind",
      BodyForCommands: "/codex bind",
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: "/codex bind",
      commandAuthorized: true,
    });

    expect(result.channel).toBe("slack");
    expect(result.channelId).toBe("slack");
    expect(result.from).toBe("gateway-client");
    expect(result.to).toBe("user:U123");
  });
});
