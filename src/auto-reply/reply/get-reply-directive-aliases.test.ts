/** Tests configured directives through parser, reply-routing, and delivery boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextEvent,
} from "../../agents/embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingSignaler } from "./typing-mode.js";

const directiveApplyMocks = vi.hoisted(() => ({
  apply: vi.fn(),
}));
const textRoutingMocks = vi.hoisted(() => ({
  shouldHandle: vi.fn(),
}));
const skillCommandMocks = vi.hoisted(() => ({
  listForWorkspace: vi.fn(),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) => directiveApplyMocks.apply(...args),
}));
vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: (...args: unknown[]) => textRoutingMocks.shouldHandle(...args),
}));
vi.mock("../../skills/discovery/chat-commands.runtime.js", () => ({
  listSkillCommandsForWorkspace: (...args: unknown[]) =>
    skillCommandMocks.listForWorkspace(...args),
}));

type DirectiveApplyParams = Parameters<
  typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides
>[0];

function configWithModelAlias(alias: string): OpenClawConfig {
  return {
    commands: { text: true },
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([
      [
        "fable",
        {
          alias: "fable",
          ref: { provider: "anthropic", model: "claude-opus-4-6" },
        },
      ],
    ]),
    byKey: new Map([["anthropic/claude-opus-4-6", ["fable"]]]),
  };
}

function createSessionEntry(): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1 };
}

function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

async function resolveModelDirective(params: {
  body: string;
  agentText?: string;
  authorized?: boolean;
  cfg?: OpenClawConfig;
  surface?: string;
  agentCfg?: Parameters<typeof resolveReplyDirectives>[0]["agentCfg"];
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
}) {
  const authorized = params.authorized ?? true;
  const { body } = params;
  const agentText = params.agentText ?? body;
  const surface = params.surface ?? "whatsapp";
  const sessionKey = "agent:main:whatsapp:+2000";
  const sessionEntry = createSessionEntry();
  const sessionCtx = {
    Body: agentText,
    BodyStripped: agentText,
    BodyForAgent: agentText,
    CommandBody: body,
    commandText: body,
    agentText,
    rawText: body,
    Provider: surface,
    Surface: surface,
  } as TemplateContext;
  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({
      Body: agentText,
      CommandBody: body,
      CommandAuthorized: authorized,
      Provider: surface,
      Surface: surface,
    }),
    cfg: withFastReplyConfig(params.cfg ?? configWithModelAlias("fable")),
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: params.agentCfg ?? {},
    opts: params.opts,
    sessionCtx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: authorized,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: createAliasIndex(),
    provider: "anthropic",
    model: "claude-opus-4-6",
    hasResolvedHeartbeatModelOverride: false,
    typing: makeTypingController(),
  });
  return { result, sessionEntry, sessionCtx };
}

describe("reply directive resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    textRoutingMocks.shouldHandle.mockImplementation(
      (params: { cfg: OpenClawConfig }) => params.cfg.commands?.text !== false,
    );
    skillCommandMocks.listForWorkspace.mockReturnValue([]);
    directiveApplyMocks.apply.mockImplementation(async (params: DirectiveApplyParams) => ({
      kind: "continue",
      directives: params.directives,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: "default off", agentCfg: {}, caption: "Attachment caption" },
    {
      label: "explicit off with text-end break",
      agentCfg: { blockStreamingDefault: "off", blockStreamingBreak: "text_end" },
      caption: "Attachment caption",
    },
    {
      label: "per-turn disabled despite configured on",
      agentCfg: { blockStreamingDefault: "on", blockStreamingBreak: "text_end" },
      opts: { disableBlockStreaming: true },
      caption: "Attachment caption",
    },
    { label: "captionless default off", agentCfg: {}, caption: "" },
    {
      label: "enabled text-end break",
      agentCfg: { blockStreamingDefault: "on", blockStreamingBreak: "text_end" },
      caption: "Attachment caption",
      separateCaption: true,
    },
    {
      label: "enabled message-end break",
      agentCfg: { blockStreamingDefault: "on", blockStreamingBreak: "message_end" },
      caption: "Attachment caption",
    },
    {
      label: "per-turn enabled despite configured off",
      agentCfg: { blockStreamingDefault: "off", blockStreamingBreak: "text_end" },
      opts: { disableBlockStreaming: false },
      caption: "Attachment caption",
      separateCaption: true,
    },
  ] satisfies Array<{
    label: string;
    agentCfg: Parameters<typeof resolveReplyDirectives>[0]["agentCfg"];
    opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
    caption: string;
    separateCaption?: boolean;
  }>)("preserves media caption ownership with $label", async (testCase) => {
    const { result } = await resolveModelDirective({
      body: "Please send the attachment",
      agentCfg: testCase.agentCfg,
      opts: "opts" in testCase ? testCase.opts : undefined,
    });
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    const delivered: ReplyPayload[] = [];
    const onPartialReply = vi.fn();
    const handleBlockReply = createBlockReplyDeliveryHandler({
      onBlockReply: (payload) => {
        delivered.push(payload);
      },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignaler({
        typing: makeTypingController(),
        mode: "never",
        isHeartbeat: false,
      }),
      blockStreamingEnabled: result.result.blockStreamingEnabled,
      blockReplyPipeline: null,
      directlySentBlockKeys: new Set(),
      directlySentBlockPayloads: [],
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "media-caption-directives",
      onBlockReply: handleBlockReply,
      onPartialReply,
      blockReplyBreak: result.result.resolvedBlockStreamingBreak,
    });
    const mediaUrl = "/tmp/attachment.txt";
    const text = `${testCase.caption}\nMEDIA:${mediaUrl}`.trimStart();
    const message = createOpenAiResponsesPartial({
      text,
      id: "media-caption",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    try {
      emit({ type: "message_start", message });
      for (const type of ["text_delta", "text_end"] as const) {
        emit(
          createOpenAiResponsesTextEvent({
            type,
            text,
            partial: message,
            messagePhase: "final_answer",
          }),
        );
        await subscription.waitForPendingEvents();
      }
      emit({ type: "message_end", message });
      await subscription.waitForPendingEvents();
      const separateCaption = "separateCaption" in testCase && testCase.separateCaption;
      expect(
        delivered.map((payload) => ({ text: payload.text ?? "", mediaUrl: payload.mediaUrl })),
      ).toEqual(
        separateCaption
          ? [
              { text: testCase.caption, mediaUrl: undefined },
              { text: "", mediaUrl },
            ]
          : [{ text: testCase.caption, mediaUrl }],
      );
      if (testCase.caption) {
        expect(onPartialReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: testCase.caption }),
        );
      }
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([
    {
      body: "/fable -s",
      expected: {
        cleaned: "",
        hasModelDirective: true,
        rawModelDirective: "fable",
        modelScope: "session",
      },
    },
    {
      body: "please /model anthropic/claude-opus-4-6 now",
      expected: {
        cleaned: "please now",
        hasModelDirective: true,
        rawModelDirective: "anthropic/claude-opus-4-6",
        rawModelProfile: undefined,
        rawModelRuntime: undefined,
      },
    },
    {
      body: "please /fable now",
      expected: {
        cleaned: "please now",
        hasModelDirective: true,
        rawModelDirective: "fable",
        rawModelProfile: undefined,
        rawModelRuntime: undefined,
      },
    },
    {
      body: "please /model anthropic/claude-opus-4-6@work --runtime codex -s now",
      expected: {
        cleaned: "please now",
        hasModelDirective: true,
        rawModelDirective: "anthropic/claude-opus-4-6",
        rawModelProfile: "work",
        rawModelRuntime: "codex",
        modelScope: "session",
      },
    },
  ])("routes model scope at the full reply boundary: $body", async ({ body, expected }) => {
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({ body });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toMatchObject(expected);
    expect(result.result.cleanedBody).toBe(expected.cleaned);
    expect(sessionCtx.Body).toBe(expected.cleaned);
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("preserves unauthorized mixed input exactly without exposing model state", async () => {
    const body = "please /model anthropic/claude-opus-4-6@work --runtime codex -s now";
    const agentText = "[wrapped]\nplease /model anthropic/claude-opus-4-6 now";
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({
      body,
      agentText,
      authorized: false,
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives(body));
    expect(result.result.cleanedBody).toBe(agentText);
    expect(sessionCtx).toMatchObject({
      agentText,
      Body: agentText,
      BodyForAgent: agentText,
      BodyStripped: agentText,
    });
    expect(result.result.provider).toBe("anthropic");
    expect(result.result.model).toBe("claude-opus-4-6");
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: expect.objectContaining({ hasModelDirective: false }),
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("keeps explicitly referenced skill payloads opaque to model directives", async () => {
    const body = "Please use $office_hours to compare /model openai/gpt-5.6-luna with the default";
    skillCommandMocks.listForWorkspace.mockReturnValue([
      {
        name: "office_hours",
        skillName: "office-hours",
        description: "Engineering office hours",
        sourceFilePath: "/tmp/office-hours/SKILL.md",
      },
    ]);

    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives(body));
    expect(result.result.cleanedBody).toBe(body);
    expect(result.result.skillCommands).toHaveLength(1);
    expect(sessionCtx).toMatchObject({
      agentText: body,
      Body: body,
      BodyForAgent: body,
      BodyStripped: body,
    });
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: clearInlineDirectives(body),
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("rejects invalid skill references before applying model directives", async () => {
    const skillCommands = Array.from({ length: 9 }, (_, index) => ({
      name: `skill_${index + 1}`,
      skillName: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
    }));
    const references = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    const body = `${references} /model openai/gpt-5.6-luna`;
    skillCommandMocks.listForWorkspace.mockReturnValue(skillCommands);

    const { result, sessionEntry } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "Too many skill references. Use at most 8 skills in one message.",
      },
    });
    expect(directiveApplyMocks.apply).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("still routes model directives after unknown skill references", async () => {
    const body = "Please use $missing_skill then /model anthropic/claude-opus-4-6";

    const { result } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toMatchObject({
      hasModelDirective: true,
      rawModelDirective: "anthropic/claude-opus-4-6",
    });
    expect(result.result.cleanedBody).toBe("Please use $missing_skill then");
  });

  it("keeps commands.text:false model syntax literal, including an empty agent projection", async () => {
    const body = "please /fable --runtime codex -s now";
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({
      body,
      agentText: "",
      cfg: {
        ...configWithModelAlias("fable"),
        commands: { text: false },
      } as OpenClawConfig,
      surface: "discord",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives(body));
    expect(result.result.cleanedBody).toBe("");
    expect(sessionCtx).toMatchObject({
      agentText: "",
      Body: "",
      BodyForAgent: "",
      BodyStripped: "",
    });
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: clearInlineDirectives(body),
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it.each([
    { label: "bare", body: "please reply /model" },
    { label: "list", body: "please reply /model list" },
    { label: "status", body: "please reply /model status" },
  ])("does not preserve a mixed $label model info directive", async ({ body }) => {
    const { result, sessionEntry } = await resolveModelDirective({ body });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives("please reply"));
    expect(result.result.cleanedBody).toBe("please reply");
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: clearInlineDirectives("please reply"),
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("parses configured alias session scope through the inline directive boundary", () => {
    const cfg = configWithModelAlias("fable");
    const parsed = parseInlineSessionDirectives("/fable -s", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands: new Set(),
      }),
    });

    expect(parsed).toMatchObject({
      cleaned: "",
      hasModelDirective: true,
      rawModelDirective: "fable",
      rawModelRuntime: undefined,
      modelScope: "session",
    });
  });

  it("does not expose skill command names as inline model aliases", () => {
    const reservedCommands = new Set<string>();
    const cfg = configWithModelAlias("demo_skill");

    const beforeSkillRegistration = parseInlineSessionDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(beforeSkillRegistration.hasModelDirective).toBe(true);
    expect(beforeSkillRegistration.cleaned).toBe("");

    reserveSkillCommandNames({
      reservedCommands,
      skillCommands: [
        {
          name: "demo_skill",
          skillName: "demo-skill",
          description: "Demo skill",
          sourceFilePath: "/tmp/demo/SKILL.md",
        },
      ],
    });

    const afterSkillRegistration = parseInlineSessionDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(afterSkillRegistration.hasModelDirective).toBe(false);
    expect(afterSkillRegistration.cleaned).toBe("/demo_skill");
  });

  it("does not expose chat command names as inline model aliases", () => {
    const cfg = configWithModelAlias(" help ");
    const reservedCommands = new Set(["help"]);

    const parsed = parseInlineSessionDirectives("/help", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(parsed.hasModelDirective).toBe(false);
    expect(parsed.cleaned).toBe("/help");
  });
});
