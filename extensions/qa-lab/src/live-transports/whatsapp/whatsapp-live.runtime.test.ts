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
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { applyQaMergePatch, collectQaSuiteGatewayConfigPatch } from "../../suite-planning.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { resolveWhatsAppQaScenarioIds } from "./scenario-selection.js";
import { runWhatsAppApprovalScenario } from "./whatsapp-live.approvals.js";
import { buildWhatsAppQaConfig, parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import {
  resolveWhatsAppQaMessageTargets,
  type WhatsAppQaScenarioImplementation,
  type WhatsAppQaScenarioMetadata,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  isTransientWhatsAppQaDriverError,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
} from "./whatsapp-live.operations.js";
import * as whatsappCapabilityScenarios from "./whatsapp-live.scenario-implementations.capabilities.js";
import * as whatsappConversationScenarios from "./whatsapp-live.scenario-implementations.conversation.js";
import * as whatsappDeliveryScenarios from "./whatsapp-live.scenario-implementations.delivery.js";
import * as whatsappUserPathScenarios from "./whatsapp-live.scenario-implementations.user-path.js";
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

function createGatewayTargetContext(gatewayTarget: string) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const context = {
    gateway: {
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push({ method, payload });
        return {};
      },
    },
    gatewayTarget,
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

type WhatsAppScenarioDefinition = WhatsAppQaScenarioMetadata & WhatsAppQaScenarioImplementation;
type WhatsAppMessageScenarioRun = Exclude<WhatsAppQaScenarioRun, { kind: "approval" }>;
type WhatsAppScenarioContext = Parameters<NonNullable<WhatsAppMessageScenarioRun["afterSend"]>>[0];
type WhatsAppQaConfigBase = Parameters<typeof testing.buildWhatsAppQaConfig>[0];
type WhatsAppQaConfigParams = Parameters<typeof testing.buildWhatsAppQaConfig>[1];
type WhatsAppMessageScenarioHook = "afterReply" | "afterSend" | "verify";

function createWhatsAppObservedMessage<
  const TOverrides extends Partial<WhatsAppQaDriverObservedMessage>,
>(messageId: string, overrides: TOverrides): WhatsAppQaDriverObservedMessage & TOverrides {
  return {
    fromPhoneE164: "+15550000002",
    kind: "text",
    messageId,
    observedAt: "2026-06-21T12:00:01.000Z",
    text: "ok",
    ...overrides,
  } as WhatsAppQaDriverObservedMessage & TOverrides;
}

function createWhatsAppScenarioGateway(
  overrides: Partial<WhatsAppScenarioContext["gateway"]> = {},
): WhatsAppScenarioContext["gateway"] {
  return {
    call: async () => ({}),
    restart: async () => {},
    workspaceDir: "/tmp/openclaw-whatsapp-qa",
    ...overrides,
  };
}

function createWhatsAppScenarioContext(
  overrides: Partial<WhatsAppScenarioContext> & {
    recordedMessages?: unknown[];
    scenario?: WhatsAppScenarioDefinition;
  } = {},
): WhatsAppScenarioContext {
  const { recordedMessages, scenario, ...contextOverrides } = overrides;
  const workspaceDir = contextOverrides.gatewayWorkspaceDir ?? "/tmp/openclaw-whatsapp-qa";
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
    recordObservedMessage: (message) => {
      recordedMessages?.push(message);
    },
    requestStartedAt: new Date("2026-06-21T12:00:00.000Z"),
    scenarioId: scenario?.id ?? "whatsapp-canary",
    scenarioTitle: scenario?.title ?? "WhatsApp QA scenario",
    sent: { messageId: "driver-message-1" },
    sutAccountId: "sut",
    sutPhoneE164: "+15550000002",
    target: "+15550000002",
    targetKind: "dm",
    waitForReady: async () => {},
    ...contextOverrides,
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

async function prepareWhatsAppFlowFixture(params: {
  config: Parameters<
    ReturnType<typeof createWhatsAppQaScenarioEnvironment>["prepareFlow"]
  >[0]["config"];
  gatewayCall: unknown;
  scenarioId: string;
  scenarioTitle: string;
}) {
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
  return await prepareFlow({
    config: params.config,
    gateway: { call: params.gatewayCall } as never,
    outputDir: "/tmp/whatsapp-output",
    primaryModel: "mock-openai/gpt-5.6-luna",
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

type WhatsAppScenarioIdFilter = string;

const whatsappScenarioImplementations = {
  ...whatsappCapabilityScenarios,
  ...whatsappConversationScenarios,
  ...whatsappDeliveryScenarios,
  ...whatsappUserPathScenarios,
} as Record<string, WhatsAppQaScenarioImplementation>;

function toWhatsAppScenarioExportName(id: string) {
  const suffix = id
    .slice("whatsapp-".length)
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
  return `whatsappQa${suffix}Scenario`;
}

function getWhatsAppScenario(id: string): WhatsAppScenarioDefinition {
  const implementation = whatsappScenarioImplementations[toWhatsAppScenarioExportName(id)];
  if (!implementation) {
    throw new Error(`missing WhatsApp test implementation for ${id}`);
  }
  const scenario = requireFlowScenario(readQaScenarioById(id));
  return {
    ...implementation,
    id,
    timeoutMs: scenario.execution.timeoutMs ?? 60_000,
    title: scenario.title,
  };
}

function findScenarios(ids: readonly string[]) {
  return ids.map(getWhatsAppScenario);
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
  const scenario = getWhatsAppScenario(id);
  const mockScenarioIds = new Set(resolveWhatsAppQaScenarioIds({ providerMode: "mock-openai" }));
  if (!mockScenarioIds.has(id)) {
    throw new Error(`missing WhatsApp mock-openai scenario ${id}`);
  }
  return scenario;
}

function requireWhatsAppMessageScenario<
  const THooks extends readonly WhatsAppMessageScenarioHook[] = [],
>(
  source: WhatsAppScenarioIdFilter | WhatsAppScenarioDefinition,
  options: { hooks?: THooks; mock?: boolean } = {},
): {
  scenario: WhatsAppScenarioDefinition;
  run: WhatsAppMessageScenarioRun & Required<Pick<WhatsAppMessageScenarioRun, THooks[number]>>;
} {
  const scenario =
    typeof source !== "string"
      ? source
      : options.mock
        ? findMockWhatsAppScenario(source)
        : getWhatsAppScenario(source);
  const run = scenario.buildRun();
  if (run.kind === "approval") {
    throw new Error(`${scenario.id} unexpectedly built an approval run`);
  }
  for (const hook of options.hooks ?? []) {
    if (!run[hook]) {
      throw new Error(`${scenario.id} missing ${hook}`);
    }
  }
  return {
    scenario,
    run: run as WhatsAppMessageScenarioRun &
      Required<Pick<WhatsAppMessageScenarioRun, THooks[number]>>,
  };
}

function createWhatsAppAgentReactionFixture(params: {
  groupJid?: string;
  triggerMessageId: string;
  waitForMessage: WhatsAppQaDriverSession["waitForMessage"];
}) {
  const scenarioId = params.groupJid
    ? "whatsapp-group-agent-message-action-react"
    : "whatsapp-agent-message-action-react";
  const { scenario, run } = requireWhatsAppMessageScenario(scenarioId, {
    hooks: ["afterSend"],
  });
  const expectedReaction = createWhatsAppObservedMessage("reaction-event-1", {
    ...(params.groupJid ? { fromJid: params.groupJid } : {}),
    kind: "reaction",
    observedAt: "2026-06-21T12:00:02.000Z",
    reaction: {
      emoji: "👍",
      messageId: params.triggerMessageId,
      ...(params.groupJid ? { participant: "15550000001@s.whatsapp.net" } : {}),
    },
    text: "👍",
  });
  const rejectedCandidates = [
    {
      ...expectedReaction,
      ...(params.groupJid
        ? { fromJid: "120363999999999999@g.us" }
        : { fromPhoneE164: "+15550000003" }),
    },
    { ...expectedReaction, reaction: { ...expectedReaction.reaction, emoji: "👎" } },
    { ...expectedReaction, reaction: { ...expectedReaction.reaction, messageId: "other-message" } },
  ];
  const recordedMessages: unknown[] = [];
  const context = createWhatsAppScenarioContext({
    driver: createWhatsAppQaDriverMock({ waitForMessage: params.waitForMessage }),
    ...(params.groupJid
      ? { gatewayTarget: params.groupJid, target: params.groupJid, targetKind: "group" as const }
      : { gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway" }),
    recordedMessages,
    scenarioId,
    scenarioTitle: params.groupJid
      ? scenario.title
      : "WhatsApp agent message action reacts to the current message",
    sent: { messageId: params.triggerMessageId },
  });
  return { context, expectedReaction, recordedMessages, rejectedCandidates, run };
}

function createWhatsAppStatusReactionFixture(...emojis: Array<"👀" | "✅">) {
  const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-status-reaction-lifecycle", {
    hooks: ["afterReply"],
    mock: true,
  });
  const reactions = emojis.map((emoji, index) =>
    createWhatsAppObservedMessage(emoji === "👀" ? "reaction-queued" : "reaction-done", {
      kind: "reaction",
      observedAt: `2026-06-21T12:00:0${index + 1}.000Z`,
      reaction: { emoji, messageId: "trigger-1" },
      text: "",
    }),
  );
  const recorded: unknown[] = [];
  const context = createWhatsAppScenarioContext({
    driver: createWhatsAppQaDriverMock({ getObservedMessages: () => reactions }),
    recordedMessages: recorded,
    scenario,
    sent: { messageId: "trigger-1" },
  });
  return { context, reactions, recorded, run };
}

async function runWhatsAppApprovalReactionFixture(params: {
  fromJid: string;
  participantJid?: string;
  scenarioId: WhatsAppScenarioIdFilter;
  turnSourceTo: string;
}) {
  const scenario = getWhatsAppScenario(params.scenarioId);
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
      const isPending = waitCount === 1;
      const message = createWhatsAppObservedMessage(
        isPending ? "approval-message-1" : "approval-resolved-1",
        {
          fromJid: params.fromJid,
          observedAt: isPending ? "2026-06-28T02:00:00.000Z" : "2026-06-28T02:00:01.000Z",
          ...(params.participantJid ? { participantJid: params.participantJid } : {}),
          text: isPending
            ? `Exec approval required\nID: ${approvalId}\n` +
              `Pending command:\nprintf '%s\\n' '${run.token}'\n\n` +
              "React with:\n\n👍 Allow Once\n👎 Deny"
            : `✅ Exec approval allow-once. ID: ${approvalId}`,
        },
      );
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
    turnSourceTo: params.turnSourceTo,
  });

  return sendReaction;
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
    const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-agent-message-action-react");

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
    const triggerMessageId = "driver-trigger-message-1";
    const { context, expectedReaction, recordedMessages, rejectedCandidates, run } =
      createWhatsAppAgentReactionFixture({
        triggerMessageId,
        waitForMessage: async (params) => {
          for (const candidate of rejectedCandidates) {
            expect(params.match(candidate)).toBe(false);
          }
          expect(params.match(expectedReaction)).toBe(true);
          return expectedReaction;
        },
      });

    const details = await run.afterSend(context);

    expect(details).toMatch(/\breaction\b/i);
    expect(recordedMessages).toEqual([expectedReaction]);
  });

  it("defines WhatsApp QA hardening scenarios as mock-backed user-path checks", () => {
    const scenarios = WHATSAPP_QA_HARDENING_SCENARIO_IDS.map((id) => findMockWhatsAppScenario(id));

    expect(scenarios.map(({ id }) => id)).toEqual([...WHATSAPP_QA_HARDENING_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const { run } = requireWhatsAppMessageScenario(scenario);

      expect(run.target).toBe("dm");
    }
  });

  it("defines WhatsApp group capability scenarios as mock-backed group checks", () => {
    const scenarios = WHATSAPP_GROUP_CAPABILITY_SCENARIO_IDS.map((id) =>
      findMockWhatsAppScenario(id),
    );

    expect(scenarios.map(({ id }) => id)).toEqual([...WHATSAPP_GROUP_CAPABILITY_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const { run } = requireWhatsAppMessageScenario(scenario);

      expect(scenario.requiresGroupJid).toBe(true);
      expect(run.target).toBe("group");
    }
  });

  it("observes native WhatsApp group reactions for the user-path action scenario", async () => {
    const groupJid = "120363000000000000@g.us";
    const triggerMessageId = "group-trigger-message-1";
    const { context, expectedReaction, recordedMessages, rejectedCandidates, run } =
      createWhatsAppAgentReactionFixture({
        groupJid,
        triggerMessageId,
        waitForMessage: async (params) => {
          for (const candidate of rejectedCandidates) {
            expect(params.match(candidate)).toBe(false);
          }
          expect(params.match(expectedReaction)).toBe(true);
          return expectedReaction;
        },
      });

    const details = await run.afterSend(context);

    expect(details).toMatch(/group agent message reaction/i);
    expect(recordedMessages).toEqual([expectedReaction]);
  });

  it("runs WhatsApp group direct Gateway media, audio, and poll probes against the group target", async () => {
    const groupJid = "120363000000000000@g.us";
    const { scenario: mediaScenario, run: mediaRun } = requireWhatsAppMessageScenario(
      "whatsapp-group-outbound-media",
      { hooks: ["afterReply"], mock: true },
    );
    const { scenario: audioScenario, run: audioRun } = requireWhatsAppMessageScenario(
      "whatsapp-group-outbound-audio",
      { hooks: ["afterReply"], mock: true },
    );
    const { scenario: pollScenario, run: pollRun } = requireWhatsAppMessageScenario(
      "whatsapp-group-outbound-poll",
      { hooks: ["afterReply"], mock: true },
    );

    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const observedMessages: WhatsAppQaDriverObservedMessage[] = [
      createWhatsAppObservedMessage("group-image-1", {
        fromJid: groupJid,
        hasMedia: true,
        kind: "media",
        mediaType: "image/png",
        observedAt: "2026-06-21T12:00:02.000Z",
        text: "",
      }),
      createWhatsAppObservedMessage("group-document-1", {
        fromJid: groupJid,
        hasMedia: true,
        kind: "media",
        mediaFileName: "whatsapp-qa-group.pdf",
        mediaType: "application/pdf",
        observedAt: "2026-06-21T12:00:03.000Z",
        text: "",
      }),
      createWhatsAppObservedMessage("group-audio-1", {
        fromJid: groupJid,
        hasMedia: true,
        kind: "media",
        mediaType: "audio/ogg; codecs=opus",
        observedAt: "2026-06-21T12:00:04.000Z",
        text: "",
      }),
      createWhatsAppObservedMessage("group-audio-text-1", {
        fromJid: groupJid,
        observedAt: "2026-06-21T12:00:05.000Z",
        text: "",
      }),
      createWhatsAppObservedMessage("group-poll-1", {
        fromJid: groupJid,
        kind: "poll",
        observedAt: "2026-06-21T12:00:06.000Z",
        poll: { options: ["alpha", "beta"] },
        text: "",
      }),
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
      gateway: createWhatsAppScenarioGateway({
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          const { message, question } = payload as Record<string, unknown>;
          if (typeof question === "string" && question) {
            updateObservedMessage(observedMessages, 4, {
              observedAt: new Date().toISOString(),
              poll: { options: ["alpha", "beta"], question },
            });
          }
          if (typeof message !== "string") {
            return {};
          }
          if (message.endsWith("_IMAGE")) {
            updateObservedMessage(observedMessages, 0, {
              observedAt: new Date().toISOString(),
              text: message,
            });
          }
          if (message.endsWith("_DOCUMENT")) {
            updateObservedMessage(observedMessages, 1, {
              observedAt: new Date().toISOString(),
              text: message,
            });
          }
          if (message.endsWith("_AUDIO")) {
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
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayTarget: groupJid,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      scenario: mediaScenario,
      target: groupJid,
      targetKind: "group",
    });

    await mediaRun.afterReply(
      createWhatsAppObservedMessage("reply-1", {
        fromJid: groupJid,
        text: String(mediaRun.matchText),
      }),
      context,
    );
    await audioRun.afterReply(
      createWhatsAppObservedMessage("reply-2", {
        fromJid: groupJid,
        text: String(audioRun.matchText),
      }),
      {
        ...context,
        scenarioId: "whatsapp-group-outbound-audio",
        scenarioTitle: audioScenario.title,
      },
    );
    await pollRun.afterReply(
      createWhatsAppObservedMessage("reply-3", {
        fromJid: groupJid,
        text: String(pollRun.matchText),
      }),
      { ...context, scenarioId: "whatsapp-group-outbound-poll", scenarioTitle: pollScenario.title },
    );

    expect(gatewayCalls.map(({ method }) => method)).toEqual(["send", "send", "send", "poll"]);
    expect(gatewayCalls.every(({ payload }) => payload.to === groupJid)).toBe(true);
  });

  it("requires the reply-context isolation quoted send to carry quote metadata", async () => {
    const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-reply-context-isolation", {
      hooks: ["afterReply"],
      mock: true,
    });

    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let waitCount = 0;
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        waitCount += 1;
        const messageText = String(gatewayCalls[waitCount - 1]?.payload.message);
        const base = createWhatsAppObservedMessage(`sut-reply-${waitCount}`, {
          observedAt: new Date().toISOString(),
          text: messageText,
        });
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
      gateway: createWhatsAppScenarioGateway({
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          return {};
        },
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      scenario,
      sent: { messageId: "driver-message-1" },
    });

    await run.afterReply(
      createWhatsAppObservedMessage("initial-reply", { text: String(run.matchText) }),
      context,
    );

    expect(gatewayCalls.map(({ payload }) => payload.replyToId)).toEqual([
      "driver-message-1",
      undefined,
    ]);
    expect(waitCount).toBe(2);
  });

  it("asserts batched reply-to mode quotes the second queued message", async () => {
    const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-reply-to-mode-batched", {
      hooks: ["afterSend", "verify"],
      mock: true,
    });

    const sentTexts: string[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        sendText: async (_to, text) => {
          sentTexts.push(text);
          return { messageId: "second-batched-message" };
        },
      }),
      scenario,
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
    const { scenario, run } = requireWhatsAppMessageScenario(
      "whatsapp-agent-message-action-upload-file",
      { hooks: ["afterSend"], mock: true },
    );

    const token = /\bWHATSAPP_QA_AGENT_UPLOAD_[A-Z0-9]+\b/u.exec(run.input)?.[0];
    if (!token) {
      throw new Error("missing upload token in scenario input");
    }
    const observed: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver: createWhatsAppQaDriverMock({
        waitForMessage: async () =>
          createWhatsAppObservedMessage("media-1", {
            hasMedia: true,
            kind: "media",
            mediaType: "image/png",
            observedAt: "2026-06-21T12:00:02.000Z",
            text: token,
          }),
      }),
      recordedMessages: observed,
      scenario,
      sent: { messageId: "trigger-1" },
    });

    const details = await run.afterSend(context);

    expect(details).toContain("upload-file media");
    expect(observed).toHaveLength(1);
  });

  it("observes the WhatsApp status reaction lifecycle sequence", async () => {
    const { context, reactions, recorded, run } = createWhatsAppStatusReactionFixture("👀", "✅");

    const details = await run.afterReply(
      createWhatsAppObservedMessage("reply-1", {
        observedAt: "2026-06-21T12:00:03.000Z",
      }),
      context,
    );

    expect(details).toContain("👀 -> ✅");
    expect(recorded).toEqual(reactions);
  });

  it("rejects WhatsApp status lifecycle reactions observed out of order", async () => {
    const { context, recorded, run } = createWhatsAppStatusReactionFixture("✅", "👀");

    vi.useFakeTimers({ now: new Date("2026-06-21T12:00:00.000Z") });
    try {
      const result = run.afterReply(
        createWhatsAppObservedMessage("reply-1", {
          observedAt: "2026-06-21T12:00:03.000Z",
        }),
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
    const { calls, context } = createGatewayTargetContext("+15550000001");

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

  it("derives live-frontier selection from taxonomy and provider eligibility", () => {
    const scenarioIds = testing.resolveWhatsAppQaScenarioIds({ providerMode: "live-frontier" });

    expect(scenarioIds).toContain("whatsapp-canary");
    expect(scenarioIds).toContain("whatsapp-mention-gating");
    expect(scenarioIds).not.toContain("whatsapp-native-new-command");
  });

  it("includes mock-only scenarios when the provider lane supports them", () => {
    const scenarioIds = testing.resolveWhatsAppQaScenarioIds({ providerMode: "mock-openai" });

    expect(scenarioIds).toContain("whatsapp-audio-preflight");
    expect(scenarioIds).toContain("whatsapp-native-new-command");
    expect(scenarioIds).toContain("whatsapp-tool-only-usage-footer");
  });

  it("defines Phase 2 WhatsApp group scenarios as mock-backed user-path scenarios", () => {
    const scenarios = PHASE2_GROUP_SCENARIO_IDS.map((id) => findMockWhatsAppScenario(id));

    expect(scenarios.map(({ id }) => id)).toEqual([...PHASE2_GROUP_SCENARIO_IDS]);
    for (const scenario of scenarios) {
      const { run } = requireWhatsAppMessageScenario(scenario);

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
      const { run } = requireWhatsAppMessageScenario(scenario);

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
    const prepared = await prepareWhatsAppFlowFixture({
      config: {},
      gatewayCall,
      scenarioId: "whatsapp-canary",
      scenarioTitle: "WhatsApp DM canary",
    });
    await prepared.whatsappScenarioContext.configureScenario(
      getWhatsAppScenario("whatsapp-canary"),
    );

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
    const prepared = await prepareWhatsAppFlowFixture({
      config: { policyKey: "dmPolicy", policyValue: "disabled" },
      gatewayCall,
      scenarioId: "whatsapp-access-control-dm-disabled",
      scenarioTitle: "WhatsApp dmPolicy disabled stays quiet",
    });
    expect(prepared.whatsappScenarioContext.scenario.id).toBe(
      "whatsapp-access-control-dm-disabled",
    );
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("patches the effective WhatsApp policy for default and named SUT accounts", async () => {
    const policy = (
      id: string,
      policyKey: "dmPolicy" | "groupPolicy",
      policyValue: "disabled" | "open" | "pairing",
      staleValue: "allowlist" | "disabled" | "open",
    ) => ({ id, policyKey, policyValue, staleValue });
    const policyScenarios = [
      policy("whatsapp-access-control-dm-disabled", "dmPolicy", "disabled", "allowlist"),
      policy("whatsapp-access-control-dm-open", "dmPolicy", "open", "allowlist"),
      policy("whatsapp-access-control-group-disabled", "groupPolicy", "disabled", "open"),
      policy("whatsapp-access-control-group-open", "groupPolicy", "open", "disabled"),
      policy("whatsapp-pairing-block", "dmPolicy", "pairing", "allowlist"),
    ];

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
    const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-group-activation-always", {
      mock: true,
    });

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
        ].map((text, index) =>
          createWhatsAppObservedMessage(`sut-activation-observation-${index}`, {
            fromJid: groupJid,
            observedAt: new Date().toISOString(),
            text: text ?? "",
          }),
        );
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
      scenario,
      sent: { messageId: "activation-command-message" },
      target: groupJid,
    });
    const activationCommandReply = createWhatsAppObservedMessage("sut-activation-command-reply", {
      fromJid: groupJid,
      text: "Activation: always",
    });

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
    const { scenario, run } = requireWhatsAppMessageScenario("whatsapp-group-activation-always", {
      hooks: ["afterReply"],
      mock: true,
    });

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
        const restoreReply = createWhatsAppObservedMessage("sut-activation-restore", {
          fromJid: groupJid,
          observedAt: new Date().toISOString(),
          text: "Activation: mention",
        });
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
    const { scenario, run } = requireWhatsAppMessageScenario(
      "whatsapp-group-reply-to-bot-triggers",
      { mock: true },
    );

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
        const candidate = createWhatsAppObservedMessage("sut-reply-to-bot-final", {
          fromJid: groupJid,
          observedAt: new Date().toISOString(),
          text: marker ?? "",
        });
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
    const seedReply = createWhatsAppObservedMessage("sut-seed-reply", {
      fromJid: groupJid,
      participantJid,
      text: "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST",
    });

    await run.afterReply?.(
      seedReply,
      createWhatsAppScenarioContext({
        driver,
        gatewayTarget: groupJid,
        gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
        scenario,
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
    const runs = scenarios.map((scenario) =>
      requireWhatsAppMessageScenario(scenario, { hooks: ["verify"] }),
    );

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
    const { run } = requireWhatsAppMessageScenario("whatsapp-inbound-structured-messages");

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
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordedMessages: recorded,
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
    const groupReply = createWhatsAppObservedMessage("group-reply-1", {
      fromJid: "120363000000000000@g.us",
      fromPhoneE164: null,
      observedAt: "2026-06-05T01:00:01.000Z",
      text: "group token",
    });
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        expect(params.match(groupReply)).toBe(true);
        return groupReply;
      },
    });
    const recorded: unknown[] = [];
    const context = createWhatsAppScenarioContext({
      driver,
      gatewayTarget: "120363000000000000@g.us",
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordedMessages: recorded,
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
    const { run } = requireWhatsAppMessageScenario("whatsapp-stream-final-message-accounting");

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
    const { run } = requireWhatsAppMessageScenario("whatsapp-reply-delivery-shape", {
      hooks: ["afterReply"],
    });
    const token = String(run.matchText);
    let waitCallCount = 0;
    const driver = createWhatsAppQaDriverMock({
      waitForMessage: async (params) => {
        waitCallCount += 1;
        if (waitCallCount === 1) {
          const firstChunk = createWhatsAppObservedMessage("chunk-1", {
            observedAt: new Date().toISOString(),
            quoted: { messageId: "driver-message-1" },
            text: `${token}_LONG_BEGIN`,
          });
          expect(params.match(firstChunk)).toBe(true);
          return firstChunk;
        }

        const missingTailMarker = createWhatsAppObservedMessage("chunk-2", {
          observedAt: new Date().toISOString(),
          quoted: { messageId: "driver-message-1" },
          text: "second chunk without the tail marker",
        });
        const missingQuoteChunk = createWhatsAppObservedMessage("chunk-3", {
          observedAt: new Date().toISOString(),
          text: `${token}_LONG_END`,
        });
        const tailChunk = createWhatsAppObservedMessage("chunk-4", {
          observedAt: new Date().toISOString(),
          quoted: { messageId: "driver-message-1" },
          text: `${token}_LONG_END`,
        });
        expect(params.match(missingTailMarker)).toBe(false);
        expect(params.match(missingQuoteChunk)).toBe(false);
        expect(params.match(tailChunk)).toBe(true);
        return tailChunk;
      },
    });
    const context = createWhatsAppScenarioContext({
      driver,
      gateway: createWhatsAppScenarioGateway({
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-reply-delivery-shape",
      scenarioTitle: "WhatsApp gateway send chunks long replies",
      sent: { messageId: "driver-message-1" },
    });

    await run.afterReply(
      createWhatsAppObservedMessage("initial-reply", {
        observedAt: "2026-06-05T01:00:00.500Z",
        text: token,
      }),
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
    const sendReaction = await runWhatsAppApprovalReactionFixture({
      fromJid: "12345@g.us",
      participantJid: "999@lid",
      scenarioId: "whatsapp-approval-exec-group-reaction-native",
      turnSourceTo: "12345@g.us",
    });

    expect(sendReaction).toHaveBeenCalledWith("12345@g.us", "approval-message-1", "👍", {
      fromMe: false,
      participant: "999@lid",
    });
  });

  it("targets DM approval reactions at the approval prompt message", async () => {
    const sendReaction = await runWhatsAppApprovalReactionFixture({
      fromJid: "15550000002@s.whatsapp.net",
      scenarioId: "whatsapp-approval-exec-reaction-native",
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
    const scenario = getWhatsAppScenario("whatsapp-agent-message-action-react");
    const cfg = buildWhatsAppQaConfigFixture({
      overrides: scenario.configOverrides,
    });

    expect(cfg.channels?.whatsapp?.actions).toMatchObject({ reactions: true });
    expect(cfg.channels?.whatsapp?.reactionLevel).toBe("minimal");
    expect(cfg.tools?.alsoAllow).toContain("message");
  });

  it("defines the WhatsApp audio preflight scenario as mock-backed audio media", () => {
    const { scenario, run: scenarioRun } = requireWhatsAppMessageScenario(
      "whatsapp-audio-preflight",
    );

    expect(readQaScenarioById(scenario.id).plugins).toEqual(["openai"]);
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
    const { run: scenarioRun } = requireWhatsAppMessageScenario("whatsapp-group-audio-gating");
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
    expect(cfg.messages?.inbound?.byChannel?.whatsapp).toBe(250);
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
    expect(cfg.messages?.inbound?.byChannel?.whatsapp).toBe(0);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid]?.requireMention).toBe(true);
  });

  it("requires pending-history group replies to expose resolved SUT phone attribution", async () => {
    const groupJid = "120363000000000000@g.us";
    const { scenario, run } = requireWhatsAppMessageScenario(
      "whatsapp-group-pending-history-context",
      { mock: true },
    );
    const unresolvedReply = createWhatsAppObservedMessage("sut-lid-reply", {
      fromJid: groupJid,
      fromPhoneE164: null,
      text: run.matchText.toString(),
    });
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
    const { run: scenarioRun } = requireWhatsAppMessageScenario("whatsapp-mention-gating");
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
