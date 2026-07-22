// Qa Lab tests cover WhatsApp scenario support behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveWhatsAppAccount,
  type WhatsAppQaDriverObservedMessage,
  type WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { describe, expect, it, vi } from "vitest";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { applyQaMergePatch, collectQaSuiteGatewayConfigPatch } from "../../suite-planning.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { resolveWhatsAppQaScenarioIds } from "./scenario-selection.js";
import { runWhatsAppApprovalScenario } from "./whatsapp-live.approvals.js";
import { buildWhatsAppQaConfig, parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import { resolveWhatsAppQaMessageTargets } from "./whatsapp-live.contracts.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  isTransientWhatsAppQaDriverError,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
} from "./whatsapp-live.operations.js";
import { getWhatsAppQaScenarioDefinition } from "./whatsapp-live.scenarios.js";
import { unpackWhatsAppAuthArchive } from "./whatsapp-live.setup.js";

const runExecSpy = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/process-runtime").runExec>(),
);

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  runExecSpy.mockImplementation(actual.runExec);
  return { ...actual, runExec: runExecSpy };
});

const testing = {
  buildWhatsAppQaConfig,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  fingerprintWhatsAppCredentialId: fingerprintQaCredentialId,
  isTransientWhatsAppQaDriverError,
  parseWhatsAppQaCredentialPayload,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaScenarioIds,
  runWhatsAppApprovalScenario,
  runWhatsAppStructuredInboundChecks,
  unpackWhatsAppAuthArchive,
  waitForScenarioObservedMessage,
};

const execFileAsync = promisify(execFile);

async function createTgz(params: { entries: Record<string, string>; root: string }) {
  const sourceDir = path.join(params.root, "src");
  await fs.mkdir(sourceDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(params.entries)) {
    const filePath = path.join(sourceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  const archivePath = path.join(params.root, "archive.tgz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "."]);
  return await fs.readFile(archivePath, "base64");
}
function createGatewayTargetContext(params: { gatewayTarget: string }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const context = {
    gateway: {
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push({ method, payload });
        return {};
      },
    },
    gatewayTarget: params.gatewayTarget,
    scenarioId: "whatsapp-reply-context-isolation",
    sutAccountId: "sut",
  } satisfies Parameters<typeof testing.callWhatsAppGatewaySend>[0];
  return { calls, context };
}

function createWhatsAppQaDriverMock(
  overrides: Partial<WhatsAppQaDriverSession> = {},
): WhatsAppQaDriverSession {
  return {
    close: async () => {},
    getObservedMessages: () => [],
    sendContact: async () => ({}),
    sendLocation: async () => ({}),
    sendMedia: async () => ({}),
    sendPoll: async () => ({}),
    sendReaction: async () => ({}),
    sendSticker: async () => ({}),
    sendText: async () => ({}),
    waitForMessage: async () => ({
      kind: "text",
      observedAt: new Date().toISOString(),
      text: "ok",
    }),
    ...overrides,
  };
}

type WhatsAppScenarioDefinition = ReturnType<typeof getWhatsAppQaScenarioDefinition>;
type WhatsAppScenarioRun = ReturnType<WhatsAppScenarioDefinition["buildRun"]>;
type WhatsAppMessageScenarioRun = Exclude<WhatsAppScenarioRun, { kind: "approval" }>;
type WhatsAppScenarioContext = Parameters<NonNullable<WhatsAppMessageScenarioRun["afterSend"]>>[0];
type WhatsAppQaConfigBase = Parameters<typeof testing.buildWhatsAppQaConfig>[0];
type WhatsAppQaConfigParams = Parameters<typeof testing.buildWhatsAppQaConfig>[1];

function createWhatsAppScenarioContext(
  overrides: Partial<WhatsAppScenarioContext> = {},
): WhatsAppScenarioContext {
  const workspaceDir = overrides.gatewayWorkspaceDir ?? "/tmp/openclaw-whatsapp-qa";
  return {
    driver: createWhatsAppQaDriverMock(),
    driverPhoneE164: "+15550000001",
    gateway: {
      call: async () => {
        throw new Error("WhatsApp scenario test did not expect a Gateway call");
      },
      restart: async () => {},
      workspaceDir,
    },
    gatewayTarget: "+15550000001",
    gatewayWorkspaceDir: workspaceDir,
    recordObservedMessage: () => {},
    requestStartedAt: new Date("2026-06-21T12:00:00.000Z"),
    scenarioId: "whatsapp-canary",
    scenarioTitle: "WhatsApp QA scenario",
    sent: { messageId: "driver-message-1" },
    sutAccountId: "sut",
    sutPhoneE164: "+15550000002",
    target: "+15550000002",
    targetKind: "dm",
    waitForReady: async () => {},
    ...overrides,
  };
}

function buildWhatsAppQaConfigFixture(
  options: Partial<WhatsAppQaConfigParams> = {},
  base: WhatsAppQaConfigBase = {},
) {
  return testing.buildWhatsAppQaConfig(base, {
    allowFrom: ["+15550000001"],
    authDir: "/tmp/openclaw-whatsapp-qa-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: ["+15550000001"],
    sutAccountId: "sut",
    ...options,
  });
}

type WhatsAppScenarioIdFilter = Parameters<typeof getWhatsAppQaScenarioDefinition>[0];

function findScenarios(ids: readonly string[]) {
  return ids.map((id) => getWhatsAppQaScenarioDefinition(id));
}

function findWhatsAppScenario(id: WhatsAppScenarioIdFilter) {
  return getWhatsAppQaScenarioDefinition(id);
}

function updateObservedMessage(
  messages: WhatsAppQaDriverObservedMessage[],
  index: number,
  patch: Partial<WhatsAppQaDriverObservedMessage>,
): void {
  messages[index] = {
    ...expectDefined(messages[index], `WhatsApp observed message ${index}`),
    ...patch,
  };
}
const PHASE2_GROUP_SCENARIO_IDS = [
  "whatsapp-group-pending-history-context",
  "whatsapp-broadcast-group-fanout",
] as const;
const PHASE3_GROUP_SCENARIO_IDS = [
  "whatsapp-group-activation-always",
  "whatsapp-group-reply-to-bot-triggers",
] as const satisfies readonly WhatsAppScenarioIdFilter[];
const WHATSAPP_QA_HARDENING_SCENARIO_IDS = [
  "whatsapp-reply-to-mode-batched",
  "whatsapp-agent-message-action-upload-file",
  "whatsapp-inbound-reaction-no-trigger",
  "whatsapp-status-reaction-lifecycle",
] as const satisfies readonly WhatsAppScenarioIdFilter[];
const WHATSAPP_GROUP_CAPABILITY_SCENARIO_IDS = [
  "whatsapp-group-agent-message-action-react",
  "whatsapp-group-agent-message-action-upload-file",
  "whatsapp-group-outbound-media",
  "whatsapp-group-outbound-audio",
  "whatsapp-group-outbound-poll",
] as const satisfies readonly WhatsAppScenarioIdFilter[];

function findMockWhatsAppScenario(id: WhatsAppScenarioIdFilter) {
  const scenario = getWhatsAppQaScenarioDefinition(id);
  const mockScenarioIds = new Set(resolveWhatsAppQaScenarioIds({ providerMode: "mock-openai" }));
  if (!mockScenarioIds.has(id)) {
    throw new Error(`missing WhatsApp mock-openai scenario ${id}`);
  }
  return scenario;
}

describe("WhatsApp QA live runtime", () => {
  it("parses credential payloads and normalizes phone numbers", () => {
    const payload = testing.parseWhatsAppQaCredentialPayload({
      driverPhoneE164: "15550000001",
      sutPhoneE164: "+15550000002",
      driverAuthArchiveBase64: "driver",
      sutAuthArchiveBase64: "sut",
    });
    expect(payload.driverPhoneE164).toBe("+15550000001");
    expect(payload.sutPhoneE164).toBe("+15550000002");
    expect(payload.driverAuthArchiveBase64).toBe("driver");
    expect(payload.sutAuthArchiveBase64).toBe("sut");
  });

  it("rejects credential payloads that reuse the same phone", () => {
    expect(() =>
      testing.parseWhatsAppQaCredentialPayload({
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000001",
        driverAuthArchiveBase64: "driver",
        sutAuthArchiveBase64: "sut",
      }),
    ).toThrow("requires two distinct WhatsApp phone numbers");
  });

  it("derives a stable non-secret credential fingerprint", () => {
    expect(testing.fingerprintWhatsAppCredentialId("cred-stale-row")).toMatch(
      /^sha256:[0-9a-f]{16}$/,
    );
    expect(testing.fingerprintWhatsAppCredentialId("cred-stale-row")).toBe(
      testing.fingerprintWhatsAppCredentialId("cred-stale-row"),
    );
    expect(testing.fingerprintWhatsAppCredentialId(undefined)).toBeUndefined();
  });

  it("unpacks auth archives into a caller-provided temp directory", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
    try {
      runExecSpy.mockClear();
      const archiveBase64 = await createTgz({
        root: tempRoot,
        entries: {
          "creds.json": "{}\n",
          "session/key.json": "{}\n",
        },
      });
      const authDir = await testing.unpackWhatsAppAuthArchive({
        archiveBase64,
        label: "driver",
        parentDir: tempRoot,
      });
      await expect(fs.readFile(path.join(authDir, "creds.json"), "utf8")).resolves.toBe("{}\n");
      await expect(fs.readFile(path.join(authDir, "session/key.json"), "utf8")).resolves.toBe(
        "{}\n",
      );
      const archivePath = path.join(tempRoot, "driver.tgz");
      const execOptions = { logOutput: false, timeoutMs: 60_000 };
      expect(runExecSpy).toHaveBeenNthCalledWith(1, "tar", ["-tzf", archivePath], execOptions);
      expect(runExecSpy).toHaveBeenNthCalledWith(
        2,
        "tar",
        ["-xzf", archivePath, "-C", authDir],
        execOptions,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("can remove copied Signal sessions while preserving other auth archive state", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
    try {
      const archiveBase64 = await createTgz({
        root: tempRoot,
        entries: {
          "creds.json": "{}\n",
          "device-list-15550000001.json": "{}\n",
          "lid-mapping-123_reverse.json": "{}\n",
          "sender-key-120363000@g.us--123_1--5.json": "{}\n",
          "session-123_1.0.json": "{}\n",
          "session-123_1.5.json": "{}\n",
        },
      });
      const authDir = await testing.unpackWhatsAppAuthArchive({
        archiveBase64,
        clearSignalSessions: true,
        label: "driver",
        parentDir: tempRoot,
      });
      await expect(fs.readFile(path.join(authDir, "creds.json"), "utf8")).resolves.toBe("{}\n");
      await expect(
        fs.readFile(path.join(authDir, "device-list-15550000001.json"), "utf8"),
      ).resolves.toBe("{}\n");
      await expect(
        fs.readFile(path.join(authDir, "lid-mapping-123_reverse.json"), "utf8"),
      ).resolves.toBe("{}\n");
      await expect(
        fs.readFile(path.join(authDir, "sender-key-120363000@g.us--123_1--5.json"), "utf8"),
      ).resolves.toBe("{}\n");
      await expect(fs.stat(path.join(authDir, "session-123_1.0.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(authDir, "session-123_1.5.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
  it("registers the WhatsApp canary scenario", () => {
    const scenarios = findScenarios(["whatsapp-canary"]);
    expect(scenarios.map(({ id }) => id)).toEqual(["whatsapp-canary"]);
  });

  it("defines the user-path WhatsApp agent reaction scenario as mock-backed", () => {
    const scenario = findWhatsAppScenario("whatsapp-agent-message-action-react");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-agent-message-action-react unexpectedly built approval run");
    }

    expect(scenario.id).toBe("whatsapp-agent-message-action-react");
    expect(scenario.configOverrides).toMatchObject({ actions: true });
    expect(run.target).toBe("dm");
    expect(run.input).toMatch(/React to this WhatsApp message/i);
    expect(run.input).toMatch(/QA action check/i);
    expect(run.input).toMatch(/\bWHATSAPP_QA_AGENT_REACT_[A-Z0-9]+\b/u);
    expect(run.expectReply).toBe(false);
    expect(run.afterReply).toBeUndefined();
  });

  it("observes the native WhatsApp reaction for the user-path agent action scenario", async () => {
    const scenario = findWhatsAppScenario("whatsapp-agent-message-action-react");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterSend) {
      throw new Error("whatsapp-agent-message-action-react unexpectedly omitted afterSend");
    }

    const triggerMessageId = "driver-trigger-message-1";
    const expectedReaction = {
      fromPhoneE164: "+15550000002",
      kind: "reaction" as const,
      messageId: "reaction-event-1",
      observedAt: "2026-06-21T12:00:02.000Z",
      reaction: {
        emoji: "👍",
        messageId: triggerMessageId,
      },
      text: "👍",
    };
    const rejectedCandidates = [
      {
        ...expectedReaction,
        fromPhoneE164: "+15550000003",
      },
      {
        ...expectedReaction,
        reaction: { ...expectedReaction.reaction, emoji: "👎" },
      },
      {
        ...expectedReaction,
        reaction: { ...expectedReaction.reaction, messageId: "other-message" },
      },
    ];
    const recordedMessages: unknown[] = [];
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        for (const candidate of rejectedCandidates) {
          expect(params.match(candidate)).toBe(false);
        }
        expect(params.match(expectedReaction)).toBe(true);
        return expectedReaction;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordObservedMessage: (message: unknown) => {
        recordedMessages.push(message);
      },
      scenarioId: "whatsapp-agent-message-action-react",
      scenarioTitle: "WhatsApp agent message action reacts to the current message",
      sent: { messageId: triggerMessageId },
    });

    const details = await run.afterSend(context);

    expect(details).toMatch(/\breaction\b/i);
    expect(recordedMessages).toEqual([expectedReaction]);
  });

  it("defines WhatsApp QA hardening scenarios as mock-backed user-path checks", () => {
    const scenarios = WHATSAPP_QA_HARDENING_SCENARIO_IDS.map((id) => findMockWhatsAppScenario(id));

    expect(scenarios.map(({ id }) => id)).toEqual([...WHATSAPP_QA_HARDENING_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const run = scenario.buildRun();
      if (run.kind === "approval") {
        throw new Error(`${scenario.id} unexpectedly built an approval run`);
      }

      expect(run.target).toBe("dm");
    }
  });

  it("defines WhatsApp group capability scenarios as mock-backed group checks", () => {
    const scenarios = WHATSAPP_GROUP_CAPABILITY_SCENARIO_IDS.map((id) =>
      findMockWhatsAppScenario(id),
    );

    expect(scenarios.map(({ id }) => id)).toEqual([...WHATSAPP_GROUP_CAPABILITY_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const run = scenario.buildRun();
      if (run.kind === "approval") {
        throw new Error(`${scenario.id} unexpectedly built an approval run`);
      }

      expect(scenario.requiresGroupJid).toBe(true);
      expect(run.target).toBe("group");
    }
  });

  it("observes native WhatsApp group reactions for the user-path action scenario", async () => {
    const scenario = findWhatsAppScenario("whatsapp-group-agent-message-action-react");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterSend) {
      throw new Error("whatsapp-group-agent-message-action-react unexpectedly omitted afterSend");
    }

    const groupJid = "120363000000000000@g.us";
    const triggerMessageId = "group-trigger-message-1";
    const expectedReaction = {
      fromJid: groupJid,
      fromPhoneE164: "+15550000002",
      kind: "reaction" as const,
      messageId: "reaction-event-1",
      observedAt: "2026-06-21T12:00:02.000Z",
      reaction: {
        emoji: "👍",
        messageId: triggerMessageId,
        participant: "15550000001@s.whatsapp.net",
      },
      text: "👍",
    };
    const rejectedCandidates = [
      {
        ...expectedReaction,
        fromJid: "120363999999999999@g.us",
      },
      {
        ...expectedReaction,
        reaction: { ...expectedReaction.reaction, emoji: "👎" },
      },
      {
        ...expectedReaction,
        reaction: { ...expectedReaction.reaction, messageId: "other-message" },
      },
    ];
    const recordedMessages: unknown[] = [];
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        for (const candidate of rejectedCandidates) {
          expect(params.match(candidate)).toBe(false);
        }
        expect(params.match(expectedReaction)).toBe(true);
        return expectedReaction;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gatewayTarget: groupJid,
      recordObservedMessage: (message: unknown) => {
        recordedMessages.push(message);
      },
      scenarioId: "whatsapp-group-agent-message-action-react",
      scenarioTitle: scenario.title,
      sent: { messageId: triggerMessageId },
      target: groupJid,
      targetKind: "group",
    });

    const details = await run.afterSend(context);

    expect(details).toMatch(/group agent message reaction/i);
    expect(recordedMessages).toEqual([expectedReaction]);
  });

  it("runs WhatsApp group direct Gateway media, audio, and poll probes against the group target", async () => {
    const groupJid = "120363000000000000@g.us";
    const mediaScenario = findMockWhatsAppScenario("whatsapp-group-outbound-media");
    const mediaRun = mediaScenario.buildRun();
    const audioScenario = findMockWhatsAppScenario("whatsapp-group-outbound-audio");
    const audioRun = audioScenario.buildRun();
    const pollScenario = findMockWhatsAppScenario("whatsapp-group-outbound-poll");
    const pollRun = pollScenario.buildRun();
    if (mediaRun.kind === "approval" || !mediaRun.afterReply) {
      throw new Error("whatsapp-group-outbound-media missing afterReply");
    }
    if (audioRun.kind === "approval" || !audioRun.afterReply) {
      throw new Error("whatsapp-group-outbound-audio missing afterReply");
    }
    if (pollRun.kind === "approval" || !pollRun.afterReply) {
      throw new Error("whatsapp-group-outbound-poll missing afterReply");
    }

    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const observedMessages: WhatsAppQaDriverObservedMessage[] = [
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        hasMedia: true,
        kind: "media" as const,
        mediaType: "image/png",
        messageId: "group-image-1",
        observedAt: "2026-06-21T12:00:02.000Z",
        text: "",
      },
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        hasMedia: true,
        kind: "media" as const,
        mediaFileName: "whatsapp-qa-group.pdf",
        mediaType: "application/pdf",
        messageId: "group-document-1",
        observedAt: "2026-06-21T12:00:03.000Z",
        text: "",
      },
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        hasMedia: true,
        kind: "media" as const,
        mediaType: "audio/ogg; codecs=opus",
        messageId: "group-audio-1",
        observedAt: "2026-06-21T12:00:04.000Z",
        text: "",
      },
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        kind: "text" as const,
        messageId: "group-audio-text-1",
        observedAt: "2026-06-21T12:00:05.000Z",
        text: "",
      },
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        kind: "poll" as const,
        messageId: "group-poll-1",
        observedAt: "2026-06-21T12:00:06.000Z",
        poll: { options: ["alpha", "beta"] },
        text: "",
      },
    ];
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        const match = observedMessages.find((message) => params.match(message));
        if (!match) {
          throw new Error("missing matching group observation");
        }
        return match;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: {
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          const question =
            typeof (payload as { question?: unknown }).question === "string"
              ? (payload as { question: string }).question
              : undefined;
          if (question) {
            updateObservedMessage(observedMessages, 4, {
              observedAt: new Date().toISOString(),
              poll: { options: ["alpha", "beta"], question },
            });
          }
          const message =
            typeof (payload as { message?: unknown }).message === "string"
              ? (payload as { message: string }).message
              : undefined;
          if (message?.endsWith("_IMAGE")) {
            updateObservedMessage(observedMessages, 0, {
              observedAt: new Date().toISOString(),
              text: message,
            });
          }
          if (message?.endsWith("_DOCUMENT")) {
            updateObservedMessage(observedMessages, 1, {
              observedAt: new Date().toISOString(),
              text: message,
            });
          }
          if (message?.endsWith("_AUDIO")) {
            updateObservedMessage(observedMessages, 2, {
              observedAt: new Date().toISOString(),
            });
            updateObservedMessage(observedMessages, 3, {
              observedAt: new Date().toISOString(),
              text: message,
            });
          }
          return {};
        },
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayTarget: groupJid,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      scenarioId: "whatsapp-group-outbound-media",
      scenarioTitle: mediaScenario.title,
      target: groupJid,
      targetKind: "group",
    });

    await mediaRun.afterReply(
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "reply-1",
        observedAt: "2026-06-21T12:00:01.000Z",
        text: String(mediaRun.matchText),
      },
      context,
    );
    await audioRun.afterReply(
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "reply-2",
        observedAt: "2026-06-21T12:00:01.000Z",
        text: String(audioRun.matchText),
      },
      {
        ...context,
        scenarioId: "whatsapp-group-outbound-audio",
        scenarioTitle: audioScenario.title,
      },
    );
    await pollRun.afterReply(
      {
        fromJid: groupJid,
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "reply-3",
        observedAt: "2026-06-21T12:00:01.000Z",
        text: String(pollRun.matchText),
      },
      { ...context, scenarioId: "whatsapp-group-outbound-poll", scenarioTitle: pollScenario.title },
    );

    expect(gatewayCalls.map(({ method }) => method)).toEqual(["send", "send", "send", "poll"]);
    expect(gatewayCalls.every(({ payload }) => payload.to === groupJid)).toBe(true);
  });

  it("requires the reply-context isolation quoted send to carry quote metadata", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-reply-context-isolation");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("whatsapp-reply-context-isolation missing afterReply");
    }

    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let waitCount = 0;
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        waitCount += 1;
        const messageText = String(gatewayCalls[waitCount - 1]?.payload.message);
        const base = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: `sut-reply-${waitCount}`,
          observedAt: new Date().toISOString(),
          text: messageText,
        };
        if (waitCount === 1) {
          expect(params.match(base)).toBe(false);
          expect(params.match({ ...base, quoted: { messageId: "wrong-trigger" } })).toBe(false);
          const quoted = { ...base, quoted: { messageId: "driver-message-1" } };
          expect(params.match(quoted)).toBe(true);
          return quoted;
        }
        expect(params.match({ ...base, text: "wrong fresh marker" })).toBe(false);
        expect(params.match(base)).toBe(true);
        return base;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: {
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          return {};
        },
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      sent: { messageId: "driver-message-1" },
    });

    await run.afterReply(
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "initial-reply",
        observedAt: "2026-06-21T12:00:01.000Z",
        text: String(run.matchText),
      },
      context,
    );

    expect(gatewayCalls.map(({ payload }) => payload.replyToId)).toEqual([
      "driver-message-1",
      undefined,
    ]);
    expect(waitCount).toBe(2);
  });

  it("asserts batched reply-to mode quotes the second queued message", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-reply-to-mode-batched");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterSend || !run.verify) {
      throw new Error("whatsapp-reply-to-mode-batched missing message hooks");
    }

    const sentTexts: string[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        sendText: async (_to, text) => {
          sentTexts.push(text);
          return { messageId: "second-batched-message" };
        },
      }),
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa",
      },
      scenarioId: "whatsapp-reply-to-mode-batched",
      scenarioTitle: scenario.title,
      sent: { messageId: "first-batched-message" },
    });

    await run.afterSend(context);
    const firstMarker = run.input.match(/\bWHATSAPP_QA_BATCHED_FIRST_[A-Z0-9]+\b/u)?.[0];
    const finalMarker = String(run.matchText);
    expect(firstMarker).toEqual(expect.any(String));
    expect(sentTexts[0]).toContain(finalMarker);
    expect(sentTexts[0]).not.toContain(firstMarker);

    expect(() =>
      run.verify?.(
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          messageId: "reply-1",
          observedAt: "2026-06-21T12:00:01.000Z",
          quoted: { messageId: "second-batched-message" },
          text: "ok",
        },
        context,
      ),
    ).not.toThrow();
  });

  it("waits for media from the user-path WhatsApp upload-file scenario", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-agent-message-action-upload-file");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterSend) {
      throw new Error("whatsapp-agent-message-action-upload-file missing afterSend");
    }

    const token = /\bWHATSAPP_QA_AGENT_UPLOAD_[A-Z0-9]+\b/u.exec(run.input)?.[0];
    if (!token) {
      throw new Error("missing upload token in scenario input");
    }
    const observed: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        waitForMessage: async () => ({
          fromPhoneE164: "+15550000002",
          hasMedia: true,
          kind: "media",
          mediaType: "image/png",
          messageId: "media-1",
          observedAt: "2026-06-21T12:00:02.000Z",
          text: token,
        }),
      }),
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa",
      },
      recordObservedMessage: (message) => {
        observed.push(message);
      },
      scenarioId: "whatsapp-agent-message-action-upload-file",
      scenarioTitle: scenario.title,
      sent: { messageId: "trigger-1" },
    });

    const details = await run.afterSend(context);

    expect(details).toContain("upload-file media");
    expect(observed).toHaveLength(1);
  });

  it("observes the WhatsApp status reaction lifecycle sequence", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-status-reaction-lifecycle");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("whatsapp-status-reaction-lifecycle missing afterReply");
    }

    const reactions = [
      {
        fromPhoneE164: "+15550000002",
        kind: "reaction" as const,
        messageId: "reaction-queued",
        observedAt: "2026-06-21T12:00:01.000Z",
        reaction: { emoji: "👀", messageId: "trigger-1" },
        text: "",
      },
      {
        fromPhoneE164: "+15550000002",
        kind: "reaction" as const,
        messageId: "reaction-done",
        observedAt: "2026-06-21T12:00:02.000Z",
        reaction: { emoji: "✅", messageId: "trigger-1" },
        text: "",
      },
    ];
    const recorded: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        getObservedMessages: () => reactions,
      }),
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa",
      },
      recordObservedMessage: (message) => {
        recorded.push(message);
      },
      scenarioId: "whatsapp-status-reaction-lifecycle",
      scenarioTitle: scenario.title,
      sent: { messageId: "trigger-1" },
    });

    const details = await run.afterReply(
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "reply-1",
        observedAt: "2026-06-21T12:00:03.000Z",
        text: "ok",
      },
      context,
    );

    expect(details).toContain("👀 -> ✅");
    expect(recorded).toEqual(reactions);
  });

  it("rejects WhatsApp status lifecycle reactions observed out of order", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-status-reaction-lifecycle");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("whatsapp-status-reaction-lifecycle missing afterReply");
    }

    const reactions = [
      {
        fromPhoneE164: "+15550000002",
        kind: "reaction" as const,
        messageId: "reaction-done",
        observedAt: "2026-06-21T12:00:01.000Z",
        reaction: { emoji: "✅", messageId: "trigger-1" },
        text: "",
      },
      {
        fromPhoneE164: "+15550000002",
        kind: "reaction" as const,
        messageId: "reaction-queued",
        observedAt: "2026-06-21T12:00:02.000Z",
        reaction: { emoji: "👀", messageId: "trigger-1" },
        text: "",
      },
    ];
    const recorded: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        getObservedMessages: () => reactions,
      }),
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa",
      },
      recordObservedMessage: (message) => {
        recorded.push(message);
      },
      scenarioId: "whatsapp-status-reaction-lifecycle",
      scenarioTitle: scenario.title,
      sent: { messageId: "trigger-1" },
    });

    vi.useFakeTimers({ now: new Date("2026-06-21T12:00:00.000Z") });
    try {
      const result = run.afterReply(
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          messageId: "reply-1",
          observedAt: "2026-06-21T12:00:03.000Z",
          text: "ok",
        },
        context,
      );
      const rejection = expect(result).rejects.toThrow(
        "timed out waiting for WhatsApp status reaction sequence",
      );
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    expect(recorded).toEqual([]);
  });

  it("uses opposite DM peers for driver sends and Gateway sends", () => {
    expect(
      testing.resolveWhatsAppQaMessageTargets({
        driverPhoneE164: "+15550000001",
        scenarioTarget: "dm",
        sutPhoneE164: "+15550000002",
      }),
    ).toEqual({
      driverTarget: "+15550000002",
      gatewayTarget: "+15550000001",
    });
    expect(
      testing.resolveWhatsAppQaMessageTargets({
        driverPhoneE164: "+15550000001",
        groupJid: "120363000000000000@g.us",
        scenarioTarget: "group",
        sutPhoneE164: "+15550000002",
      }),
    ).toEqual({
      driverTarget: "120363000000000000@g.us",
      gatewayTarget: "120363000000000000@g.us",
    });
  });

  it("routes WhatsApp Gateway DM helper calls to the driver peer", async () => {
    const { calls, context } = createGatewayTargetContext({
      gatewayTarget: "+15550000001",
    });

    await testing.callWhatsAppGatewaySend(context, {
      label: "quoted",
      message: "WHATSAPP_QA_QUOTED",
      replyToId: "driver-message-1",
    });
    await testing.callWhatsAppGatewayPoll(context, {
      label: "poll",
      options: ["alpha", "beta"],
      question: "WHATSAPP_QA_POLL",
    });
    await testing.callWhatsAppGatewayMessageAction(context, {
      action: "react",
      label: "react",
      params: {
        emoji: "👍",
        messageId: "driver-message-1",
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.payload).toMatchObject({ to: "+15550000001" });
    expect(calls[1]?.payload).toMatchObject({ to: "+15550000001" });
    expect(calls[2]?.payload.params).toMatchObject({
      emoji: "👍",
      messageId: "driver-message-1",
      to: "+15550000001",
    });
    expect(calls[2]?.payload).toMatchObject({
      conversationReadOrigin: "direct-operator",
    });
  });

  it("keeps mock-backed and native approval scenarios out of default live-frontier selection", () => {
    const expectedDefaultIds = [
      "whatsapp-canary",
      "whatsapp-mention-gating",
      "whatsapp-top-level-reply-shape",
      "whatsapp-reply-to-message",
      "whatsapp-group-reply-to-message",
      "whatsapp-status-reactions",
      "whatsapp-group-allowlist-block",
    ];

    expect(
      testing.resolveWhatsAppQaScenarioIds({ providerMode: "live-frontier" }).slice(0, -1),
    ).toEqual(expectedDefaultIds);
  });

  it("adds deterministic audio preflight to the default mock-openai WhatsApp selection", () => {
    expect(testing.resolveWhatsAppQaScenarioIds({ providerMode: "mock-openai" })).toEqual([
      "whatsapp-canary",
      "whatsapp-mention-gating",
      "whatsapp-group-pending-history-context",
      "whatsapp-broadcast-group-fanout",
      "whatsapp-group-activation-always",
      "whatsapp-group-reply-to-bot-triggers",
      "whatsapp-top-level-reply-shape",
      "whatsapp-reply-to-message",
      "whatsapp-group-reply-to-message",
      "whatsapp-reply-to-mode-batched",
      "whatsapp-agent-message-action-react",
      "whatsapp-agent-message-action-upload-file",
      "whatsapp-group-agent-message-action-react",
      "whatsapp-group-agent-message-action-upload-file",
      "whatsapp-inbound-reaction-no-trigger",
      "whatsapp-reply-context-isolation",
      "whatsapp-inbound-image-caption",
      "whatsapp-audio-preflight",
      "whatsapp-outbound-media-matrix",
      "whatsapp-outbound-document-preserves-filename",
      "whatsapp-outbound-poll",
      "whatsapp-group-outbound-media",
      "whatsapp-group-outbound-audio",
      "whatsapp-group-outbound-poll",
      "whatsapp-message-actions",
      "whatsapp-inbound-structured-messages",
      "whatsapp-group-audio-gating",
      "whatsapp-reply-delivery-shape",
      "whatsapp-stream-final-message-accounting",
      "whatsapp-status-reactions",
      "whatsapp-status-reaction-lifecycle",
      "whatsapp-group-allowlist-block",
      "whatsapp-help-command",
      "whatsapp-commands-command",
      "whatsapp-tools-compact-command",
      "whatsapp-whoami-command",
      "whatsapp-context-command",
      "whatsapp-tool-only-usage-footer",
      "whatsapp-native-new-command",
    ]);
  });

  it("defines Phase 2 WhatsApp group scenarios as mock-backed user-path scenarios", () => {
    const scenarios = PHASE2_GROUP_SCENARIO_IDS.map((id) => findMockWhatsAppScenario(id));

    expect(scenarios.map(({ id }) => id)).toEqual([...PHASE2_GROUP_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const run = scenario.buildRun();
      if (run.kind === "approval") {
        throw new Error(`${scenario.id} unexpectedly built an approval run`);
      }

      expect(scenario.requiresGroupJid).toBe(true);
      expect(run.target).toBe("group");
      expect(run.configMode).toBe("open");
      expect(run.input).toContain("openclawqa");
    }
  });

  it("defines Phase 3 WhatsApp group scenarios as owner-backed mention-gated mock scenarios", () => {
    const groupJid = "120363000000000000@g.us";
    const scenarios = PHASE3_GROUP_SCENARIO_IDS.map((id) => findMockWhatsAppScenario(id));

    expect(scenarios.map(({ id }) => id)).toEqual([...PHASE3_GROUP_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const run = scenario.buildRun();
      if (run.kind === "approval") {
        throw new Error(`${scenario.id} unexpectedly built an approval run`);
      }

      expect(scenario.requiresGroupJid).toBe(true);
      expect(scenario.configOverrides).toMatchObject({ groupPolicy: "open" });
      expect(run.target).toBe("group");
      expect(run.configMode).toBe("allowlist");

      const cfg = buildWhatsAppQaConfigFixture({
        dmPolicy: run.configMode,
        groupJid,
        overrides: scenario.configOverrides,
      });
      const account = cfg.channels?.whatsapp?.accounts?.sut;
      expect(account?.allowFrom).toEqual(["+15550000001"]);
      expect(cfg.commands?.ownerAllowFrom).toEqual(["+15550000001"]);
      expect(account?.groupPolicy).toBe("open");
      expect(account?.groups?.[groupJid]?.requireMention).toBe(true);
    }
  });

  it("authorizes the exact active WhatsApp account allowlist replacement path", async () => {
    const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config.get") {
        return { config: {}, hash: "config-hash" };
      }
      if (method === "config.patch") {
        return { noop: true };
      }
      if (method === "channels.status") {
        return {
          channelAccounts: {
            whatsapp: [
              {
                accountId: "work",
                busy: false,
                connected: true,
                lastConnectedAt: Date.now() - 30_000,
                restartPending: false,
                running: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });
    const { prepareFlow } = createWhatsAppQaScenarioEnvironment({
      accountId: "work",
      driverAuthDir: "/tmp/whatsapp-driver",
      explicitScenarioSelection: true,
      getDriver: vi.fn(() => undefined as never),
      replaceDriver: vi.fn(),
      runtimeEnv: {
        driverAuthArchiveBase64: "driver-auth",
        driverPhoneE164: "+15550000001",
        sutAuthArchiveBase64: "sut-auth",
        sutPhoneE164: "+15550000002",
      },
      sutAuthDir: "/tmp/whatsapp-sut",
    });

    await prepareFlow({
      config: { whatsappScenarioId: "whatsapp-canary" },
      gateway: { call: gatewayCall } as never,
      outputDir: "/tmp/whatsapp-output",
      primaryModel: "mock-openai/gpt-5.6-luna",
      timeoutMs: 60_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    const patchCall = gatewayCall.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("config.patch was not called");
    }
    expect(patchCall[1]).toMatchObject({
      replacePaths: expect.arrayContaining(["channels.whatsapp.accounts.work.allowFrom"]),
    });
    expect((patchCall[1] as { replacePaths?: string[] }).replacePaths).not.toContain(
      "channels.whatsapp.accounts.sut.allowFrom",
    );
  });

  it("leaves generic declarative flows to their own config preparation", async () => {
    const gatewayCall = vi.fn();
    const { prepareFlow } = createWhatsAppQaScenarioEnvironment({
      accountId: "work",
      driverAuthDir: "/tmp/whatsapp-driver",
      explicitScenarioSelection: true,
      getDriver: vi.fn(() => undefined as never),
      replaceDriver: vi.fn(),
      runtimeEnv: {
        driverAuthArchiveBase64: "driver-auth",
        driverPhoneE164: "+15550000001",
        sutAuthArchiveBase64: "sut-auth",
        sutPhoneE164: "+15550000002",
      },
      sutAuthDir: "/tmp/whatsapp-sut",
    });

    await expect(
      prepareFlow({
        config: { policyKey: "dmPolicy", policyValue: "disabled" },
        gateway: { call: gatewayCall } as never,
        outputDir: "/tmp/whatsapp-output",
        primaryModel: "mock-openai/gpt-5.6-luna",
        timeoutMs: 60_000,
        waitForConfigRestartSettle: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("patches the effective WhatsApp policy for default and named SUT accounts", async () => {
    const policyScenarios = [
      {
        id: "whatsapp-access-control-dm-disabled",
        policyKey: "dmPolicy",
        policyValue: "disabled",
        staleValue: "allowlist",
      },
      {
        id: "whatsapp-access-control-dm-open",
        policyKey: "dmPolicy",
        policyValue: "open",
        staleValue: "allowlist",
      },
      {
        id: "whatsapp-access-control-group-disabled",
        policyKey: "groupPolicy",
        policyValue: "disabled",
        staleValue: "open",
      },
      {
        id: "whatsapp-access-control-group-open",
        policyKey: "groupPolicy",
        policyValue: "open",
        staleValue: "disabled",
      },
      {
        id: "whatsapp-pairing-block",
        policyKey: "dmPolicy",
        policyValue: "pairing",
        staleValue: "allowlist",
      },
    ] as const;

    for (const accountId of ["default", "work"]) {
      for (const policyScenario of policyScenarios) {
        const staleAccount = {
          [policyScenario.policyKey]: policyScenario.staleValue,
        };
        const initialConfig = buildWhatsAppQaConfigFixture(
          { sutAccountId: accountId },
          {
            channels: {
              whatsapp: {
                accounts: { [accountId]: staleAccount },
              },
            },
          },
        );
        const scenario = readQaScenarioById(policyScenario.id);
        const flow = scenario.execution.kind === "flow" ? scenario.execution.flow : undefined;
        expect(JSON.stringify(flow), policyScenario.id).not.toContain('"patchConfig"');
        const startupPatch = collectQaSuiteGatewayConfigPatch([scenario], accountId);
        const patchedConfig = applyQaMergePatch(
          initialConfig,
          startupPatch ?? {},
        ) as WhatsAppQaConfigBase;
        const effective = resolveWhatsAppAccount({ cfg: patchedConfig, accountId });
        expect(
          effective[policyScenario.policyKey],
          `${policyScenario.id}:${accountId}:effective`,
        ).toBe(policyScenario.policyValue);

        if (policyScenario.id === "whatsapp-pairing-block") {
          expect(effective.allowFrom).toEqual(["+15550000000"]);
        }
      }
    }
  });

  it("preserves configured command owners while adding the WhatsApp QA driver", () => {
    const cfg = buildWhatsAppQaConfigFixture(
      {},
      {
        commands: { ownerAllowFrom: ["telegram:existing-owner"] },
      },
    );

    expect(cfg.commands?.ownerAllowFrom).toEqual(["telegram:existing-owner", "+15550000001"]);
  });

  it("models activation always through visible group behavior and restores mention gating", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-group-activation-always");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-group-activation-always unexpectedly built an approval run");
    }

    expect(run.target).toBe("group");
    expect(run.input).toBe("/activation always");

    const sentTextCalls: Array<{ text: string; to: string }> = [];
    let alwaysModeReplyMatched = false;
    let restoredQuietObservationReads = 0;
    const groupJid = "120363000000000000@g.us";
    const driver = createWhatsAppQaDriverMock({
      getObservedMessages: () => {
        if (
          sentTextCalls.some(({ text }) => /\bWHATSAPP_QA_ACTIVATION_QUIET_[A-Z0-9]+\b/u.test(text))
        ) {
          restoredQuietObservationReads += 1;
        }
        return [];
      },
      sendText: async (to, text) => {
        sentTextCalls.push({ text, to });
        return { messageId: `driver-message-${sentTextCalls.length}` };
      },
      waitForMessage: async (params) => {
        const matches = params.match;
        const latestProbe = sentTextCalls.findLast(
          ({ text }) =>
            /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u.test(text) &&
            !/\bopenclawqa\b/iu.test(text),
        );
        if (latestProbe) {
          expect(
            matches({
              fromJid: groupJid,
              fromPhoneE164: "+15550000002",
              kind: "text" as const,
              messageId: "sut-activation-wrong-marker",
              observedAt: new Date().toISOString(),
              text: latestProbe.text.replace(
                /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u,
                "WHATSAPP_QA_ACTIVATION_ALWAYS_WRONG",
              ),
            }),
          ).toBe(false);
        }
        const candidates = [
          latestProbe?.text,
          "Activation: always",
          "Activation: mention",
          "Status: activation always",
          "Status: activation mention",
        ].map((text, index) => ({
          fromJid: groupJid,
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: `sut-activation-observation-${index}`,
          observedAt: new Date().toISOString(),
          text: text ?? "",
        }));
        for (const candidate of candidates) {
          if (matches(candidate)) {
            if (candidate.text === latestProbe?.text) {
              alwaysModeReplyMatched = true;
            }
            return candidate;
          }
        }
        throw new Error(
          `activation scenario waited for an unexpected message after ${latestProbe?.text}`,
        );
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gatewayTarget: groupJid,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      sent: { messageId: "activation-command-message" },
      target: groupJid,
    });
    const activationCommandReply = {
      fromJid: groupJid,
      fromPhoneE164: "+15550000002",
      kind: "text" as const,
      messageId: "sut-activation-command-reply",
      observedAt: "2026-06-21T12:00:01.000Z",
      text: "Activation: always",
    };

    const followUp = run.afterReply ?? run.afterSend;
    expect(followUp).toEqual(expect.any(Function));
    vi.useFakeTimers({ now: new Date("2026-06-21T12:00:02.000Z") });
    try {
      const followUpResult =
        run.afterReply !== undefined
          ? run.afterReply(activationCommandReply, context as never)
          : run.afterSend?.(context as never);
      await vi.runAllTimersAsync();
      await followUpResult;
    } finally {
      vi.useRealTimers();
    }

    const alwaysProbe = sentTextCalls.find(({ text }) =>
      /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u.test(text),
    );
    expect(alwaysProbe?.to).toBe(groupJid);
    expect(alwaysProbe?.text).not.toMatch(/\bopenclawqa\b/i);
    expect(alwaysModeReplyMatched).toBe(true);
    const restoreIndex = sentTextCalls.findIndex(
      ({ text, to }) => to === groupJid && text.trim() === "/activation mention",
    );
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    const restoredQuietProbe = sentTextCalls
      .slice(restoreIndex + 1)
      .find(({ text }) => /\bWHATSAPP_QA_ACTIVATION_QUIET_[A-Z0-9]+\b/u.test(text));
    expect(restoredQuietProbe?.to).toBe(groupJid);
    expect(restoredQuietProbe?.text).not.toMatch(/\bopenclawqa\b/i);
    expect(restoredQuietObservationReads).toBeGreaterThan(0);
  });

  it("restores mention gating when activation always validation fails", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-group-activation-always");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("whatsapp-group-activation-always unexpectedly built a non-message run");
    }

    const sentTextCalls: Array<{ text: string; to: string }> = [];
    const groupJid = "120363000000000000@g.us";
    const driver = createWhatsAppQaDriverMock({
      sendText: async (to, text) => {
        sentTextCalls.push({ text, to });
        return { messageId: `driver-message-${sentTextCalls.length}` };
      },
      waitForMessage: async (params) => {
        const matches = params.match;
        const restoreSent = sentTextCalls.some(
          ({ text, to }) => to === groupJid && text.trim() === "/activation mention",
        );
        if (!restoreSent) {
          throw new Error("forced always-mode probe failure");
        }
        const restoreReply = {
          fromJid: groupJid,
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "sut-activation-restore",
          observedAt: new Date().toISOString(),
          text: "Activation: mention",
        };
        if (matches(restoreReply)) {
          return restoreReply;
        }
        throw new Error("activation restore wait used an unexpected matcher");
      },
    });

    await expect(
      run.afterReply(
        {
          fromJid: groupJid,
          fromPhoneE164: "+15550000002",
          kind: "text",
          messageId: "sut-activation-command-reply",
          observedAt: "2026-06-21T12:00:01.000Z",
          text: "Activation: always",
        },
        createWhatsAppScenarioContext({
          driver,
          gatewayTarget: groupJid,
          gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          sent: { messageId: "activation-command-message" },
          target: groupJid,
        }),
      ),
    ).rejects.toThrow("forced always-mode probe failure");

    expect(sentTextCalls.some(({ text }) => text.trim() === "/activation mention")).toBe(true);
  });

  it("quotes the observed SUT reply without an explicit mention for reply-to-bot activation", async () => {
    const scenario = findMockWhatsAppScenario("whatsapp-group-reply-to-bot-triggers");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-group-reply-to-bot-triggers unexpectedly built an approval run");
    }

    expect(run.target).toBe("group");
    expect(run.input).toMatch(/\bopenclawqa\b/iu);
    expect(run.input).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u);
    expect(run.afterReply).toEqual(expect.any(Function));

    const groupJid = "120363000000000000@g.us";
    const participantJid = "15550000002@s.whatsapp.net";
    const sendTextCalls: Array<{
      options: Parameters<WhatsAppQaDriverSession["sendText"]>[2];
      text: string;
      to: string;
    }> = [];
    let replyWaits = 0;
    let finalReplyMarkerMatched = false;
    let finalReplyQuoteMatched = false;
    const driver = createWhatsAppQaDriverMock({
      sendText: async (to, text, options) => {
        sendTextCalls.push({ options, text, to });
        return { messageId: `driver-quoted-${sendTextCalls.length}` };
      },
      waitForMessage: async (params) => {
        const matches = params.match;
        replyWaits += 1;
        const quotedTrigger = sendTextCalls.find((call) => call.options?.quotedMessageKey);
        const marker = quotedTrigger
          ? /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u.exec(quotedTrigger.text)?.[0]
          : undefined;
        if (!marker) {
          throw new Error("reply-to-bot scenario waited before sending the quoted trigger");
        }
        const candidate = {
          fromJid: groupJid,
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "sut-reply-to-bot-final",
          observedAt: new Date().toISOString(),
          text: marker ?? "",
        };
        expect(
          matches({
            ...candidate,
            messageId: "sut-reply-to-bot-wrong-marker",
            text: "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_WRONG",
          }),
        ).toBe(false);
        expect(matches(candidate)).toBe(false);
        const quotedCandidate = {
          ...candidate,
          quoted: { messageId: "driver-quoted-1" },
        };
        if (matches(quotedCandidate)) {
          finalReplyMarkerMatched = true;
          finalReplyQuoteMatched = true;
          return quotedCandidate;
        }
        throw new Error("reply-to-bot scenario waited for an unexpected message");
      },
    });
    const seedReply = {
      fromJid: groupJid,
      fromPhoneE164: "+15550000002",
      kind: "text" as const,
      messageId: "sut-seed-reply",
      observedAt: "2026-06-21T12:00:01.000Z",
      participantJid,
      text: "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST",
    };

    await run.afterReply?.(
      seedReply,
      createWhatsAppScenarioContext({
        driver,
        gatewayTarget: groupJid,
        gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        sent: { messageId: "driver-seed-message" },
        target: groupJid,
      }),
    );

    const quotedSend = sendTextCalls.find((call) => call.options?.quotedMessageKey);
    expect(quotedSend?.to).toBe(groupJid);
    expect(quotedSend?.text).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u);
    expect(quotedSend?.text).not.toMatch(/\bopenclawqa\b/i);
    expect(quotedSend?.text).not.toMatch(/@\d/u);
    expect(quotedSend?.options?.quotedMessageKey).toMatchObject({
      fromMe: false,
      id: "sut-seed-reply",
      messageText: seedReply.text,
      participant: participantJid,
      remoteJid: groupJid,
    });
    expect(replyWaits).toBeGreaterThan(0);
    expect(finalReplyMarkerMatched).toBe(true);
    expect(finalReplyQuoteMatched).toBe(true);
  });

  it("defines quote-reply scenarios for DM and group replies", () => {
    const scenarios = findScenarios([
      "whatsapp-reply-to-message",
      "whatsapp-group-reply-to-message",
    ]);
    const runs = scenarios.map((scenario) => {
      const run = scenario.buildRun();
      if (run.kind === "approval" || !run.verify) {
        throw new Error(`${scenario.id} unexpectedly built a non-message run`);
      }
      return { scenario, run };
    });

    expect(
      runs.map(({ scenario, run }) => ({
        id: scenario.id,
        requiresGroupJid: scenario.requiresGroupJid,
        target: run.target,
      })),
    ).toEqual([
      {
        id: "whatsapp-reply-to-message",
        requiresGroupJid: undefined,
        target: "dm",
      },
      {
        id: "whatsapp-group-reply-to-message",
        requiresGroupJid: true,
        target: "group",
      },
    ]);
    expect(runs[0]?.run.input).not.toContain("openclawqa");
    expect(runs[1]?.run.input).toMatch(/^openclawqa\b/u);

    for (const { run } of runs) {
      expect(() =>
        run.verify?.(
          {
            kind: "text",
            observedAt: "2026-06-05T01:00:01.000Z",
            quoted: { messageId: "trigger-message-id" },
            text: "reply",
          },
          { sent: { messageId: "trigger-message-id" } } as never,
        ),
      ).not.toThrow();
      expect(() =>
        run.verify?.(
          {
            kind: "text",
            observedAt: "2026-06-05T01:00:01.000Z",
            text: "reply",
          },
          { sent: { messageId: "trigger-message-id" } } as never,
        ),
      ).toThrow("expected reply quote trigger-message-id, got <missing>");
    }
  });

  it("seeds the structured-message location check through text context", () => {
    const scenario = findWhatsAppScenario("whatsapp-inbound-structured-messages");
    if (!scenario) {
      throw new Error("missing structured WhatsApp scenario");
    }
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("structured WhatsApp scenario unexpectedly built an approval run");
    }

    expect(run.input).toContain("37.774900, -122.419400");
    expect(run.input).toContain("WhatsApp location marker");
    expect(run.input).toContain("WhatsApp contact marker");
    expect(run.input).toContain("WhatsApp sticker marker");
    expect(run.input).toContain("exact marker before structured inbound checks");
  });

  it("sends a WhatsApp-routable contact card in the structured-message check", async () => {
    const sendContact = vi.fn(async () => ({ messageId: "contact-1" }));
    const driver = createWhatsAppQaDriverMock({
      sendContact,
      sendLocation: vi.fn(async () => ({ messageId: "location-1" })),
      sendMedia: vi.fn(async () => ({ messageId: "document-1" })),
      sendSticker: vi.fn(async () => ({ messageId: "sticker-1" })),
    });

    await testing.runWhatsAppStructuredInboundChecks({
      contactToken: "CONTACT_TOKEN",
      documentToken: "DOCUMENT_TOKEN",
      driver,
      driverPhoneE164: "+15550000001",
      locationToken: "LOCATION_TOKEN",
      stickerToken: "STICKER_TOKEN",
      target: "+15550000002",
      waitForStructuredReply: async () => {},
    });

    expect(sendContact).toHaveBeenCalledWith(
      "+15550000002",
      expect.objectContaining({
        vcard: expect.stringContaining("waid=15550000001:+15550000001"),
      }),
    );
  });

  it("labels structured-message contact wait failures", async () => {
    const sendSticker = vi.fn(async () => ({ messageId: "sticker-1" }));
    const driver = createWhatsAppQaDriverMock({
      sendContact: vi.fn(async () => ({ messageId: "contact-1" })),
      sendLocation: vi.fn(async () => ({ messageId: "location-1" })),
      sendMedia: vi.fn(async () => ({ messageId: "document-1" })),
      sendSticker,
    });

    await expect(
      testing.runWhatsAppStructuredInboundChecks({
        contactToken: "CONTACT_TOKEN",
        documentToken: "DOCUMENT_TOKEN",
        driver,
        driverPhoneE164: "+15550000001",
        locationToken: "LOCATION_TOKEN",
        stickerToken: "STICKER_TOKEN",
        target: "+15550000002",
        waitForStructuredReply: async (label, _observedAfter, expectedToken) => {
          if (label === "contact") {
            throw new Error(
              `timed out waiting for WhatsApp structured ${label} reply (${expectedToken})`,
            );
          }
        },
      }),
    ).rejects.toThrow("timed out waiting for WhatsApp structured contact reply");
    expect(sendSticker).not.toHaveBeenCalled();
  });
  it("adds safe diagnostics when a WhatsApp scenario reply wait observes nothing", async () => {
    const driver = createWhatsAppQaDriverMock({
      getObservedMessages: () => [],
      waitForMessage: async () => {
        throw new Error("timed out waiting for WhatsApp QA driver message");
      },
    });
    const recorded: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordObservedMessage: (message: unknown) => {
        recorded.push(message);
      },
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-canary",
      scenarioTitle: "WhatsApp DM canary",
    });

    await expect(
      testing.waitForScenarioObservedMessage(context, {
        observedAfter: new Date("2026-06-05T01:00:00.000Z"),
        match: () => true,
      }),
    ).rejects.toThrow("observed 0 WhatsApp driver message(s) after wait lower bound");
    expect(recorded).toEqual([]);
  });

  it("lets WhatsApp scenario waits use caller-specific sender matching", async () => {
    const groupReply = {
      fromJid: "120363000000000000@g.us",
      fromPhoneE164: null,
      kind: "text" as const,
      messageId: "group-reply-1",
      observedAt: "2026-06-05T01:00:01.000Z",
      text: "group token",
    };
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        expect(params.match(groupReply)).toBe(true);
        return groupReply;
      },
    });
    const recorded: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayTarget: "120363000000000000@g.us",
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordObservedMessage: (message: unknown) => {
        recorded.push(message);
      },
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-mention-gating",
      scenarioTitle: "WhatsApp group mention gating",
      target: "120363000000000000@g.us",
    });

    await expect(
      testing.waitForScenarioObservedMessage(context, {
        expectedSender: (message) => message.fromJid === "120363000000000000@g.us",
        match: (message) => message.text.includes("group token"),
      }),
    ).resolves.toBe(groupReply);
    expect(recorded).toEqual([groupReply]);
  });

  it("defines WhatsApp final-message accounting as a settled two-chunk assertion", () => {
    const scenario = findWhatsAppScenario("whatsapp-stream-final-message-accounting");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-stream-final-message-accounting unexpectedly built approval run");
    }

    expect(run.input).toContain("WhatsApp long final QA check");
    expect(run.matchText).toBe("WHATSAPP-LONG-FINAL-BEGIN");
    expect(run.expectedJoinedSutTextIncludes).toEqual([
      "WHATSAPP-LONG-FINAL-BEGIN",
      "WHATSAPP-LONG-FINAL-END",
    ]);
    expect(run.expectedSutMessageCount).toBe(2);
    expect(run.settleMs).toBe(4_000);
  });

  it("requires the long-reply delivery-shape tail marker in the second chunk", async () => {
    const scenario = findWhatsAppScenario("whatsapp-reply-delivery-shape");
    const run = scenario.buildRun();
    if (run.kind === "approval" || !run.afterReply) {
      throw new Error("whatsapp-reply-delivery-shape unexpectedly omitted afterReply");
    }
    const token = String(run.matchText);
    let waitCallCount = 0;
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        waitCallCount += 1;
        if (waitCallCount === 1) {
          const firstChunk = {
            fromPhoneE164: "+15550000002",
            kind: "text" as const,
            messageId: "chunk-1",
            observedAt: new Date().toISOString(),
            quoted: { messageId: "driver-message-1" },
            text: `${token}_LONG_BEGIN`,
          };
          expect(params.match(firstChunk)).toBe(true);
          return firstChunk;
        }

        const missingTailMarker = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "chunk-2",
          observedAt: new Date().toISOString(),
          quoted: { messageId: "driver-message-1" },
          text: "second chunk without the tail marker",
        };
        const missingQuoteChunk = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "chunk-3",
          observedAt: new Date().toISOString(),
          text: `${token}_LONG_END`,
        };
        const tailChunk = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "chunk-4",
          observedAt: new Date().toISOString(),
          quoted: { messageId: "driver-message-1" },
          text: `${token}_LONG_END`,
        };
        expect(params.match(missingTailMarker)).toBe(false);
        expect(params.match(missingQuoteChunk)).toBe(false);
        expect(params.match(tailChunk)).toBe(true);
        return tailChunk;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-reply-delivery-shape",
      scenarioTitle: "WhatsApp gateway send chunks long replies",
      sent: { messageId: "driver-message-1" },
    });

    await run.afterReply(
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "initial-reply",
        observedAt: "2026-06-05T01:00:00.500Z",
        text: token,
      },
      context,
    );

    expect(waitCallCount).toBe(2);
  });

  it("selects native approval scenarios by id without changing standard scenario coverage", () => {
    const scenarios = findScenarios([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-exec-reaction-native",
      "whatsapp-approval-exec-group-reaction-native",
      "whatsapp-approval-plugin-native",
    ]);

    expect(scenarios.map(({ id }) => id)).toEqual([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-exec-reaction-native",
      "whatsapp-approval-exec-group-reaction-native",
      "whatsapp-approval-plugin-native",
    ]);
    expect(scenarios.map((scenario) => scenario.buildRun().kind)).toEqual([
      "approval",
      "approval",
      "approval",
      "approval",
    ]);
    expect(scenarios[1]?.buildRun()).toMatchObject({
      decisionMode: "reaction",
    });
    expect(scenarios[2]?.buildRun()).toMatchObject({
      decisionMode: "reaction",
      target: "group",
    });
  });

  it("targets group approval reactions at the approval prompt participant", async () => {
    const scenario = findWhatsAppScenario("whatsapp-approval-exec-group-reaction-native");
    const run = scenario.buildRun();
    if (run.kind !== "approval") {
      throw new Error("expected approval scenario run");
    }
    const sendReaction = vi.fn(async () => ({ messageId: "reaction-1" }));
    let approvalId = "";
    let waitCount = 0;
    const driver = createWhatsAppQaDriverMock({
      sendReaction,
      waitForMessage: async ({ match }) => {
        waitCount += 1;
        const message =
          waitCount === 1
            ? {
                fromJid: "12345@g.us",
                fromPhoneE164: "+15550000002",
                kind: "text" as const,
                messageId: "approval-message-1",
                observedAt: "2026-06-28T02:00:00.000Z",
                participantJid: "999@lid",
                text:
                  `Exec approval required\nID: ${approvalId}\n` +
                  `Pending command:\nprintf '%s\\n' '${run.token}'\n\n` +
                  "React with:\n\n👍 Allow Once\n👎 Deny",
              }
            : {
                fromJid: "12345@g.us",
                fromPhoneE164: "+15550000002",
                kind: "text" as const,
                messageId: "approval-resolved-1",
                observedAt: "2026-06-28T02:00:01.000Z",
                participantJid: "999@lid",
                text: `✅ Exec approval allow-once. ID: ${approvalId}`,
              };
        if (!match(message)) {
          throw new Error(`approval test message ${waitCount} did not match`);
        }
        return message;
      },
    });
    const gateway = {
      call: async (method: string, payload: { id?: string }) => {
        if (method === "exec.approval.request") {
          approvalId = payload.id ?? "";
          return { id: approvalId, status: "accepted" };
        }
        if (method === "exec.approval.waitDecision") {
          return { decision: "allow-once" };
        }
        throw new Error(`unexpected gateway call ${method}`);
      },
    } as Parameters<typeof testing.runWhatsAppApprovalScenario>[0]["gateway"];

    await testing.runWhatsAppApprovalScenario({
      driver,
      gateway,
      observedMessages: [],
      run,
      scenario,
      sutAccountId: "work",
      sutPhoneE164: "+15550000002",
      turnSourceTo: "12345@g.us",
    });

    expect(sendReaction).toHaveBeenCalledWith("12345@g.us", "approval-message-1", "👍", {
      fromMe: false,
      participant: "999@lid",
    });
  });

  it("targets DM approval reactions at the approval prompt message", async () => {
    const scenario = findWhatsAppScenario("whatsapp-approval-exec-reaction-native");
    const run = scenario.buildRun();
    if (run.kind !== "approval") {
      throw new Error("expected approval scenario run");
    }
    const sendReaction = vi.fn(async () => ({ messageId: "reaction-1" }));
    let approvalId = "";
    let waitCount = 0;
    const driver = createWhatsAppQaDriverMock({
      sendReaction,
      waitForMessage: async ({ match }) => {
        waitCount += 1;
        const message =
          waitCount === 1
            ? {
                fromJid: "15550000002@s.whatsapp.net",
                fromPhoneE164: "+15550000002",
                kind: "text" as const,
                messageId: "approval-message-1",
                observedAt: "2026-06-28T02:00:00.000Z",
                text:
                  `Exec approval required\nID: ${approvalId}\n` +
                  `Pending command:\nprintf '%s\\n' '${run.token}'\n\n` +
                  "React with:\n\n👍 Allow Once\n👎 Deny",
              }
            : {
                fromJid: "15550000002@s.whatsapp.net",
                fromPhoneE164: "+15550000002",
                kind: "text" as const,
                messageId: "approval-resolved-1",
                observedAt: "2026-06-28T02:00:01.000Z",
                text: `✅ Exec approval allow-once. ID: ${approvalId}`,
              };
        if (!match(message)) {
          throw new Error(`approval test message ${waitCount} did not match`);
        }
        return message;
      },
    });
    const gateway = {
      call: async (method: string, payload: { id?: string }) => {
        if (method === "exec.approval.request") {
          approvalId = payload.id ?? "";
          return { id: approvalId, status: "accepted" };
        }
        if (method === "exec.approval.waitDecision") {
          return { decision: "allow-once" };
        }
        throw new Error(`unexpected gateway call ${method}`);
      },
    } as Parameters<typeof testing.runWhatsAppApprovalScenario>[0]["gateway"];

    await testing.runWhatsAppApprovalScenario({
      driver,
      gateway,
      observedMessages: [],
      run,
      scenario,
      sutAccountId: "work",
      sutPhoneE164: "+15550000002",
      turnSourceTo: "+15550000002",
    });

    expect(sendReaction).toHaveBeenCalledWith(
      "15550000002@s.whatsapp.net",
      "approval-message-1",
      "👍",
      {
        fromMe: false,
        participant: undefined,
      },
    );
  });

  it("enables WhatsApp native exec and plugin approval delivery for approval scenarios", () => {
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: {
        approvals: {
          exec: true,
          plugin: true,
        },
      },
    });

    expect(cfg.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const account = cfg.channels?.whatsapp?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["+15550000001"]);
    expect(account).not.toHaveProperty("execApprovals");
  });

  it("enables WhatsApp audio preflight with the OpenAI transcription provider", () => {
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: {
        audioPreflight: true,
      },
    });

    expect(cfg.plugins?.allow).toContain("whatsapp");
    expect(cfg.tools?.media?.audio).toEqual({ enabled: true });
    expect(cfg.tools?.media?.models?.[0]).toEqual({
      provider: "openai",
      model: "gpt-4o-transcribe",
      capabilities: ["audio"],
    });
  });

  it("enables WhatsApp action discovery for message action scenarios", () => {
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: {
        actions: true,
      },
    });

    expect(cfg.channels?.whatsapp?.actions).toEqual({ reactions: true, polls: true });
    expect(cfg.channels?.whatsapp?.reactionLevel).toBe("minimal");
  });

  it("enables WhatsApp action discovery for the user-path agent reaction scenario", () => {
    const scenario = findWhatsAppScenario("whatsapp-agent-message-action-react");
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: scenario.configOverrides,
    });

    expect(cfg.channels?.whatsapp?.actions).toMatchObject({ reactions: true });
    expect(cfg.channels?.whatsapp?.reactionLevel).toBe("minimal");
    expect(cfg.tools?.alsoAllow).toContain("message");
  });

  it("defines the WhatsApp audio preflight scenario as mock-backed audio media", () => {
    const scenario = findWhatsAppScenario("whatsapp-audio-preflight");
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-audio-preflight unexpectedly built an approval scenario run");
    }

    expect(scenario.requiredPluginIds).toEqual(["openai"]);
    expect(scenarioRun.expectReply).toBe(true);
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-audio.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(scenarioRun.sendMode?.kind === "media" && scenarioRun.sendMode.mediaBuffer.length).toBe(
      1_303,
    );
  });

  it("defines group audio gating as captionless audio driven by mock transcription sentinel", () => {
    const scenario = findWhatsAppScenario("whatsapp-group-audio-gating");
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-group-audio-gating unexpectedly built an approval scenario run");
    }
    const triggerSentinel = Buffer.from("OPENCLAW_QA_GROUP_AUDIO_TRIGGER", "utf8");

    expect(scenarioRun.input).toBe("");
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.quietInput).toBe("");
    expect(scenarioRun.quietMatchText).toBeUndefined();
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(scenarioRun.quietSendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio-quiet.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(
      scenarioRun.sendMode?.kind === "media" &&
        scenarioRun.quietSendMode?.kind === "media" &&
        scenarioRun.quietSendMode.mediaBuffer.length === 1_303 &&
        scenarioRun.sendMode.mediaBuffer.includes(triggerSentinel) &&
        !scenarioRun.quietSendMode.mediaBuffer.includes(triggerSentinel),
    ).toBe(true);
  });

  it("applies WhatsApp QA config overrides for reply mode and status reactions", () => {
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: {
        inboundDebounceMs: 250,
        replyToMode: "all",
        statusReactions: true,
      },
    });

    expect(cfg.channels?.whatsapp?.accounts?.sut?.replyToMode).toBe("all");
    expect(cfg.channels?.whatsapp?.accounts?.sut?.debounceMs).toBe(250);
    expect(cfg.channels?.whatsapp?.ackReaction).toMatchObject({
      direct: true,
      emoji: "👀",
    });
    expect(cfg.messages?.statusReactions?.enabled).toBe(true);
  });

  it("maps WhatsApp broadcast overrides without deleting existing agent defaults", () => {
    const groupJid = "120363000000000000@g.us";
    const broadcastOverrides = {
      broadcast: {
        agents: ["main", "qa-second"],
        strategy: "sequential" as const,
      },
      groupPolicy: "open" as const,
    };
    const cfg = buildWhatsAppQaConfigFixture(
      {
        groupJid,
        overrides: broadcastOverrides,
      },
      {
        agents: {
          defaults: {
            maxConcurrent: 7,
            model: "mock-openai/gpt-5.6-luna",
            workspace: "/workspace/qa",
          },
          list: [
            {
              default: true,
              id: "main",
              identity: { name: "Main WhatsApp QA" },
              model: "mock-openai/gpt-5.6-luna",
            },
          ],
        },
      },
    );

    expect(cfg.agents?.defaults).toEqual({
      maxConcurrent: 7,
      model: "mock-openai/gpt-5.6-luna",
      workspace: "/workspace/qa",
    });
    expect(cfg.agents?.list?.map((agent) => agent.id)).toEqual(["main", "qa-second"]);
    expect(cfg.agents?.list?.find((agent) => agent.id === "main")).toMatchObject({
      default: true,
      identity: { name: "Main WhatsApp QA" },
      model: "mock-openai/gpt-5.6-luna",
    });
    expect(cfg.broadcast?.strategy).toBe("sequential");
    expect(cfg.broadcast?.[groupJid]).toEqual(["main", "qa-second"]);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid]?.requireMention).toBe(true);
  });

  it("keeps pending-history group context enabled through the supported config path", () => {
    const groupJid = "120363000000000000@g.us";
    const scenario = findMockWhatsAppScenario("whatsapp-group-pending-history-context");
    const cfg = buildWhatsAppQaConfigFixture({
      groupJid,
      overrides: scenario.configOverrides,
    });
    const supportedHistoryLimit =
      cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit;

    expect(supportedHistoryLimit).toEqual(expect.any(Number));
    expect(supportedHistoryLimit).toBeGreaterThan(0);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.replyToMode).toBe("all");
    expect(cfg.channels?.whatsapp?.accounts?.sut?.debounceMs).toBe(0);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid]?.requireMention).toBe(true);
  });

  it("requires pending-history group replies to expose resolved SUT phone attribution", async () => {
    const groupJid = "120363000000000000@g.us";
    const scenario = findMockWhatsAppScenario("whatsapp-group-pending-history-context");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("pending-history scenario unexpectedly built an approval run");
    }
    const unresolvedReply = {
      fromJid: groupJid,
      fromPhoneE164: null,
      kind: "text" as const,
      messageId: "sut-lid-reply",
      observedAt: "2026-06-21T12:00:01.000Z",
      text: run.matchText.toString(),
    };
    const driver = createWhatsAppQaDriverMock({
      getObservedMessages: () => [unresolvedReply],
      waitForMessage: async (params) => {
        expect(params.match(unresolvedReply)).toBe(false);
        throw new Error("timed out waiting for WhatsApp QA driver message");
      },
    });

    await expect(
      testing.waitForScenarioObservedMessage(
        createWhatsAppScenarioContext({
          driver,
          gatewayTarget: groupJid,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          target: groupJid,
          targetKind: "group",
        }),
        {
          match: (message) => message.text.includes(run.matchText.toString()),
          observedAfter: new Date("2026-06-21T12:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("fromExpectedSut=no");
  });

  it("can configure a group scenario as sender allowlist-blocked instead of open mention-gated", () => {
    const cfg = buildWhatsAppQaConfigFixture({
      allowFrom: ["+15550000000"],
      groupJid: "120363000000000000@g.us",
      overrides: {
        blockGroupSender: true,
        groupPolicy: "allowlist",
      },
    });

    const account = cfg.channels?.whatsapp?.accounts?.sut;
    expect(account?.groupPolicy).toBe("allowlist");
    expect(account?.groupAllowFrom).toEqual(["+15550000001"]);
    expect(account?.groupAllowFrom).not.toContain("+15550000000");
    expect(account?.groups).toBeUndefined();
  });
  it("uses automatic visible replies for WhatsApp group mention gating", () => {
    const scenario = findWhatsAppScenario("whatsapp-mention-gating");
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-mention-gating unexpectedly built an approval scenario run");
    }
    expect(scenarioRun.input).toContain("openclawqa reply with only this exact marker");
    expect(scenarioRun.input).not.toContain("visible reply tool check");

    const cfg = buildWhatsAppQaConfigFixture({
      groupJid: "120363000000000000@g.us",
    });
    expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(cfg.messages?.groupChat?.mentionPatterns).toContain("\\bopenclawqa\\b");
  });
  it("classifies WhatsApp driver connection closures as retryable", () => {
    expect(testing.isTransientWhatsAppQaDriverError(new Error("Connection Closed"))).toBe(true);
    expect(
      testing.isTransientWhatsAppQaDriverError(new Error("status 440: session conflict")),
    ).toBe(true);
    expect(testing.isTransientWhatsAppQaDriverError(new Error("Stream Errored (conflict)"))).toBe(
      true,
    );
    expect(
      testing.isTransientWhatsAppQaDriverError(
        new Error("timed out after 45000ms waiting for WhatsApp QA driver pending notifications"),
      ),
    ).toBe(true);
    expect(
      testing.isTransientWhatsAppQaDriverError(
        new Error("timed out waiting for WhatsApp QA driver message"),
      ),
    ).toBe(false);
    expect(testing.isTransientWhatsAppQaDriverError(new Error("timed out waiting"))).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
