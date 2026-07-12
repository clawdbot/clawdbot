// Qa Lab tests cover whatsapp live plugin behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { describe, expect, it, vi } from "vitest";
import { testing } from "./whatsapp-live.runtime.js";

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

function createDiagnosticsContext(
  messages: Array<{
    fromPhoneE164: string | null;
    kind: "media" | "poll" | "reaction" | "text" | "unknown";
    messageId?: string;
    observedAt: string;
    quoted?: { messageId?: string; text?: string };
    text: string;
  }>,
) {
  return {
    driver: {
      getObservedMessages: () => messages,
    },
    sutPhoneE164: "+15550000002",
    target: "+15550000001",
    targetKind: "dm",
  } satisfies Parameters<typeof testing.formatWhatsAppScenarioWaitDiagnostics>[0];
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

type WhatsAppScenarioDefinition = ReturnType<typeof testing.findScenarios>[number];
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
    sutAccountId: "sut",
    ...options,
  });
}

type WhatsAppScenarioIdFilter = NonNullable<Parameters<typeof testing.findScenarios>[0]>[number];

function findWhatsAppScenario(id: WhatsAppScenarioIdFilter) {
  return expectDefined(testing.findScenarios([id])[0], `WhatsApp QA scenario ${id}`);
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
const DIRECT_GATEWAY_SCENARIO_IDS = [
  "whatsapp-outbound-media-matrix",
  "whatsapp-outbound-document-preserves-filename",
  "whatsapp-outbound-poll",
  "whatsapp-outbound-send-serialization",
  "whatsapp-message-actions",
  "whatsapp-group-outbound-media",
  "whatsapp-group-outbound-audio",
  "whatsapp-group-outbound-poll",
  "whatsapp-reply-context-isolation",
  "whatsapp-reply-delivery-shape",
] as const satisfies readonly WhatsAppScenarioIdFilter[];
const DIRECT_GATEWAY_LABEL_RE = /\b(?:direct Gateway|Gateway)\b/u;
const NATIVE_APPROVAL_SCENARIO_IDS = [
  "whatsapp-approval-exec-deny-native",
  "whatsapp-approval-exec-native",
  "whatsapp-approval-exec-reaction-native",
  "whatsapp-approval-exec-group-reaction-native",
  "whatsapp-approval-plugin-native",
] as const satisfies readonly WhatsAppScenarioIdFilter[];
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
  const scenario = testing
    .findScenarios(undefined, "mock-openai")
    .find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`missing WhatsApp mock-openai scenario ${id}`);
  }
  return scenario;
}

describe("WhatsApp QA live runtime", () => {
  it("waits for WhatsApp channel pending work before treating it as ready", () => {
    expect(
      testing.isWhatsAppChannelReady({
        busy: true,
        connected: true,
        restartPending: false,
        running: true,
      }),
    ).toBe(false);
    expect(
      testing.isWhatsAppChannelReady({ connected: true, restartPending: false, running: true }),
    ).toBe(true);
  });

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

  it("redacts observed message content and phone metadata by default", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: false,
        redactMetadata: true,
        messages: [
          {
            fromJid: "15550000002@s.whatsapp.net",
            fromPhoneE164: "+15550000002",
            kind: "text",
            matchedScenario: true,
            messageId: "msg-1",
            observedAt: "2026-05-04T12:00:00.000Z",
            scenarioId: "whatsapp-canary",
            scenarioTitle: "WhatsApp DM canary",
            text: "secret body",
          },
        ],
      }),
    ).toEqual([
      {
        kind: "text",
        matchedScenario: true,
        observedAt: "2026-05-04T12:00:00.000Z",
        scenarioId: "whatsapp-canary",
        scenarioTitle: "WhatsApp DM canary",
      },
    ]);
  });

  it("keeps observed message content only when capture is requested", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: true,
        redactMetadata: true,
        messages: [
          {
            fromPhoneE164: "+15550000002",
            kind: "text",
            observedAt: "2026-05-04T12:00:00.000Z",
            text: "captured body",
          },
        ],
      }),
    ).toEqual([
      {
        kind: "text",
        observedAt: "2026-05-04T12:00:00.000Z",
        text: "captured body",
      },
    ]);
  });

  it("does not expose quoted message text when only metadata capture is enabled", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: false,
        redactMetadata: false,
        messages: [
          {
            fromPhoneE164: "+15550000002",
            kind: "text",
            messageId: "msg-1",
            observedAt: "2026-05-04T12:00:00.000Z",
            quoted: {
              messageId: "quoted-msg-1",
              participant: "15550000001@s.whatsapp.net",
              text: "quoted secret body",
            },
            text: "secret body",
          },
        ],
      }),
    ).toEqual([
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "msg-1",
        observedAt: "2026-05-04T12:00:00.000Z",
        quoted: {
          messageId: "quoted-msg-1",
          participant: "15550000001@s.whatsapp.net",
          text: undefined,
        },
      },
    ]);
  });

  it("does not expose reaction emoji when content capture is disabled", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: false,
        redactMetadata: false,
        messages: [
          {
            fromPhoneE164: "+15550000002",
            kind: "reaction",
            messageId: "reaction-msg-1",
            observedAt: "2026-05-04T12:00:00.000Z",
            reaction: {
              emoji: "👍",
              fromMe: false,
              messageId: "target-msg-1",
              participant: "15550000001@s.whatsapp.net",
            },
            text: "👍",
          },
        ],
      }),
    ).toEqual([
      {
        fromPhoneE164: "+15550000002",
        kind: "reaction",
        messageId: "reaction-msg-1",
        observedAt: "2026-05-04T12:00:00.000Z",
        reaction: {
          fromMe: false,
          messageId: "target-msg-1",
          participant: "15550000001@s.whatsapp.net",
        },
      },
    ]);
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

  it("keeps credential fingerprints visible in redacted reports", () => {
    const report = testing.renderWhatsAppQaMarkdown({
      cleanupIssues: [],
      credentialFingerprint: "sha256:1234567890abcdef",
      credentialSource: "convex",
      finishedAt: "2026-05-04T12:01:00.000Z",
      redactMetadata: true,
      scenarios: [],
      startedAt: "2026-05-04T12:00:00.000Z",
      sutPhoneE164: "+15550000002",
    });

    expect(report).toContain("Credential fingerprint: `sha256:1234567890abcdef`");
    expect(report).toContain("SUT phone: `<redacted>`");
    expect(report).not.toContain("+15550000002");
  });

  it("publishes WhatsApp gateway debug artifacts only when files exist", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-debug-test-"));
    const debugDir = path.join(tempRoot, "gateway-debug");
    try {
      await expect(testing.hasWhatsAppGatewayDebugArtifacts(debugDir)).resolves.toBe(false);
      await fs.mkdir(debugDir);
      await expect(testing.hasWhatsAppGatewayDebugArtifacts(debugDir)).resolves.toBe(false);
      await fs.writeFile(path.join(debugDir, "gateway.stderr.log"), "stderr\n");
      await expect(testing.hasWhatsAppGatewayDebugArtifacts(debugDir)).resolves.toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("redacts published WhatsApp run output without advertising empty debug artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-publish-test-"));
    const debugDir = path.join(tempRoot, "gateway-debug");
    try {
      await fs.mkdir(debugDir);
      const emptyDebugView = await testing.buildPublishedWhatsAppQaRunView({
        cleanupIssues: [
          "WhatsApp QA failed during driver session start: private setup failure details for +15550000002",
        ],
        gatewayDebugDirPath: debugDir,
        preservedGatewayDebugArtifacts: true,
        redactMetadata: true,
        scenarioResults: [
          {
            id: "whatsapp-canary",
            title: "WhatsApp DM canary",
            standardId: "canary",
            posture: "user-path",
            status: "fail",
            details:
              "WhatsApp QA failed during driver session start: private setup failure details for +15550000002",
          },
        ],
      });

      expect(emptyDebugView.gatewayDebugDirPath).toBeUndefined();
      expect(emptyDebugView.cleanupIssues).toEqual([
        "WhatsApp QA failed during driver session start: " +
          "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
      ]);
      expect(emptyDebugView.scenarioResults[0]?.details).toBe(
        "WhatsApp QA failed during driver session start",
      );

      const poolExhaustedView = await testing.buildPublishedWhatsAppQaRunView({
        cleanupIssues: [
          'WhatsApp QA failed during credential lease acquisition: Convex credential pool exhausted for kind "whatsapp" after 1800000ms. private broker detail +15550000002',
        ],
        gatewayDebugDirPath: debugDir,
        preservedGatewayDebugArtifacts: false,
        redactMetadata: true,
        scenarioResults: [
          {
            id: "whatsapp-canary",
            title: "WhatsApp DM canary",
            standardId: "canary",
            posture: "user-path",
            status: "fail",
            details:
              'WhatsApp QA failed during credential lease acquisition: Convex credential pool exhausted for kind "whatsapp" after 1800000ms. private broker detail +15550000002',
          },
        ],
      });

      expect(poolExhaustedView.cleanupIssues).toEqual([
        'WhatsApp QA failed during credential lease acquisition: Convex credential pool exhausted for kind "whatsapp" after 1800000ms.',
      ]);
      expect(poolExhaustedView.scenarioResults[0]?.details).toBe(
        'WhatsApp QA failed during credential lease acquisition: Convex credential pool exhausted for kind "whatsapp" after 1800000ms.',
      );
      expect(JSON.stringify(poolExhaustedView)).not.toContain("+15550000002");

      await fs.writeFile(path.join(debugDir, "gateway.stderr.log"), "stderr\n");
      await expect(
        testing.buildPublishedWhatsAppQaRunView({
          cleanupIssues: [],
          gatewayDebugDirPath: debugDir,
          preservedGatewayDebugArtifacts: true,
          redactMetadata: true,
          scenarioResults: [],
        }),
      ).resolves.toMatchObject({ gatewayDebugDirPath: debugDir });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("redacts published scenario details before rendering public artifacts", () => {
    const publishedScenarios = testing.redactWhatsAppQaScenarioResults([
      {
        id: "whatsapp-reply-delivery-shape",
        title: "WhatsApp gateway send chunks long replies",
        posture: "direct-gateway",
        status: "pass",
        details: "long reply chunked across raw-message-id-1 and raw-message-id-2",
      },
      {
        id: "whatsapp-inbound-structured-messages",
        title: "WhatsApp inbound structured messages reach the agent",
        posture: "user-path",
        status: "fail",
        details:
          "timed out waiting for WhatsApp QA driver message; observed 2 WhatsApp driver message(s) after wait lower bound: #1 observedAt=2026-06-04T23:47:00.000Z fromPhone=present kind=text textLength=17 messageId=present(length=10) quoted=missing quotedMessageId=missing fromExpectedSut=yes containsExpectedToken=no; #2 observedAt=2026-06-04T23:47:01.000Z fromPhone=present kind=text textLength=24 messageId=present(length=10) quoted=missing quotedMessageId=missing fromExpectedSut=no containsExpectedToken=yes",
      },
    ]);
    const report = testing.renderWhatsAppQaMarkdown({
      cleanupIssues: [
        "temporary auth cleanup failed: details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
      ],
      credentialSource: "convex",
      finishedAt: "2026-05-04T12:01:00.000Z",
      redactMetadata: true,
      scenarios: publishedScenarios,
      startedAt: "2026-05-04T12:00:00.000Z",
      sutPhoneE164: "+15550000002",
    });

    expect(publishedScenarios[0]?.details).toBe(
      "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
    );
    expect(publishedScenarios[1]?.details).toContain("observed 2 WhatsApp driver message(s)");
    expect(publishedScenarios[1]?.details).toContain("fromExpectedSut=yes");
    expect(publishedScenarios[1]?.details).toContain("textLength=17");
    expect(report).toContain("Details: details redacted");
    expect(report).toContain("Posture: direct-gateway");
    expect(report).toContain("Posture: user-path");
    expect(report).toContain("observed 2 WhatsApp driver message(s)");
    expect(report).toContain("fromExpectedSut=yes");
    expect(report).toContain("textLength=17");
    expect(report).not.toContain("raw-message-id-1");
    expect(report).not.toContain("raw-message-id-2");
    expect(report).not.toContain("+15550000002");
  });

  it("unpacks auth archives into a caller-provided temp directory", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
    try {
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

  it("rejects unsafe archive entries before extraction", () => {
    expect(() => testing.assertSafeArchiveEntries(["../creds.json"])).toThrow("unsafe entry");
    expect(() => testing.assertSafeArchiveEntries(["/tmp/creds.json"])).toThrow("unsafe entry");
  });

  it("registers the WhatsApp canary scenario", () => {
    const scenarios = testing.findScenarios(["whatsapp-canary"]);
    expect(scenarios.map(({ id }) => id)).toEqual(["whatsapp-canary"]);
  });

  it("keeps direct Gateway scenario ids stable while labeling report headings as Gateway probes", () => {
    const scenarios = testing.findScenarios([...DIRECT_GATEWAY_SCENARIO_IDS]);

    expect(scenarios).toHaveLength(DIRECT_GATEWAY_SCENARIO_IDS.length);
    expect(scenarios.map(({ id }) => id)).toEqual(
      expect.arrayContaining([...DIRECT_GATEWAY_SCENARIO_IDS]),
    );
    for (const scenario of scenarios) {
      expect(scenario.title).toMatch(DIRECT_GATEWAY_LABEL_RE);
    }

    const report = testing.renderWhatsAppQaMarkdown({
      cleanupIssues: [],
      credentialSource: "env",
      finishedAt: "2026-06-21T12:01:00.000Z",
      redactMetadata: true,
      scenarios: scenarios.map((scenario) => ({
        details: "direct Gateway contract probe",
        id: scenario.id,
        posture: testing.WHATSAPP_QA_SCENARIO_POSTURES[scenario.id],
        status: "pass",
        title: scenario.title,
      })),
      startedAt: "2026-06-21T12:00:00.000Z",
    });

    for (const scenario of scenarios) {
      expect(report).toContain(`### ${scenario.title}`);
    }
    expect(report).toContain("- Posture: direct-gateway");
  });

  it("classifies every WhatsApp QA scenario by test posture", () => {
    const scenarios = testing.findScenarios([
      ...testing.findScenarios(undefined, "mock-openai").map(({ id }) => id),
      ...NATIVE_APPROVAL_SCENARIO_IDS,
    ]);
    const scenarioIds = new Set(scenarios.map(({ id }) => id));

    for (const scenarioId of scenarioIds) {
      expect(testing.WHATSAPP_QA_SCENARIO_POSTURES[scenarioId]).toMatch(
        /^(?:direct-gateway|native-approval|user-path)$/u,
      );
    }
    for (const scenarioId of DIRECT_GATEWAY_SCENARIO_IDS) {
      expect(testing.WHATSAPP_QA_SCENARIO_POSTURES[scenarioId]).toBe("direct-gateway");
    }
    for (const scenarioId of NATIVE_APPROVAL_SCENARIO_IDS) {
      expect(testing.WHATSAPP_QA_SCENARIO_POSTURES[scenarioId]).toBe("native-approval");
    }
    expect(testing.WHATSAPP_QA_SCENARIO_POSTURES["whatsapp-reply-to-message"]).toBe("user-path");
    expect(testing.WHATSAPP_QA_SCENARIO_POSTURES["whatsapp-agent-message-action-upload-file"]).toBe(
      "user-path",
    );
  });

  it("preserves scenario posture for WhatsApp live evidence checks", () => {
    expect(
      testing.toWhatsAppLiveTransportEvidenceChecks([
        {
          details: "direct Gateway contract probe",
          id: "whatsapp-message-actions",
          posture: "direct-gateway",
          standardId: "message-actions",
          status: "pass",
          title: "WhatsApp direct Gateway message.action supports reactions",
        },
      ]),
    ).toEqual([
      {
        coverageIds: ["channels.whatsapp.message-actions"],
        details: "direct Gateway contract probe",
        id: "whatsapp-message-actions",
        posture: "direct-gateway",
        status: "pass",
        title: "WhatsApp direct Gateway message.action supports reactions",
      },
    ]);
  });

  it("defines the user-path WhatsApp agent reaction scenario as mock-backed", () => {
    const scenario = findWhatsAppScenario("whatsapp-agent-message-action-react");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-agent-message-action-react unexpectedly built approval run");
    }

    expect(scenario.id).toBe("whatsapp-agent-message-action-react");
    expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
    expect(testing.findScenarios(undefined, "mock-openai").map(({ id }) => id)).toContain(
      "whatsapp-agent-message-action-react",
    );
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

      expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
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

      expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
      expect(scenario.requiresGroupJid).toBe(true);
      expect(run.target).toBe("group");
    }
    expect(testing.WHATSAPP_QA_SCENARIO_POSTURES["whatsapp-group-agent-message-action-react"]).toBe(
      "user-path",
    );
    expect(testing.WHATSAPP_QA_SCENARIO_POSTURES["whatsapp-group-outbound-media"]).toBe(
      "direct-gateway",
    );
    expect(testing.WHATSAPP_QA_SCENARIO_POSTURES["whatsapp-group-outbound-audio"]).toBe(
      "direct-gateway",
    );
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

  it("reports WhatsApp live transport standard scenario coverage", () => {
    expect(testing.WHATSAPP_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "top-level-reply-shape",
      "quote-reply",
      "reaction-observation",
      "allowlist-block",
    ]);
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
  });

  it("formats redacted wait diagnostics for unmatched WhatsApp observations", () => {
    const diagnostics = testing.formatWhatsAppScenarioWaitDiagnostics(
      createDiagnosticsContext([
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          messageId: "before-lower-bound",
          observedAt: "2026-06-05T00:59:59.000Z",
          text: "SECRET_BEFORE",
        },
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          messageId: "fresh-message-secret-id",
          observedAt: "2026-06-05T01:00:01.000Z",
          quoted: { messageId: "quoted-secret-id", text: "quoted secret body" },
          text: "SECRET_MARKER",
        },
        {
          fromPhoneE164: "+15550000003",
          kind: "media",
          messageId: "other-sender-secret-id",
          observedAt: "2026-06-05T01:00:02.000Z",
          text: "SECRET_OTHER",
        },
      ]),
      {
        diagnosticChecks: [
          {
            label: "textMarker",
            match: (message) => message.text.includes("SECRET_MARKER"),
          },
          {
            label: "quoteMatchesTrigger",
            match: (message) => message.quoted?.messageId === "trigger-message",
          },
        ],
        observedAfter: new Date("2026-06-05T01:00:00.000Z"),
      },
    );

    expect(diagnostics).toContain("observed 2 WhatsApp driver message(s)");
    expect(diagnostics).toContain("fromExpectedSut=yes");
    expect(diagnostics).toContain("fromExpectedSut=no");
    expect(diagnostics).toContain("textMarker=yes");
    expect(diagnostics).toContain("quoteMatchesTrigger=no");
    expect(diagnostics).toContain("quoted=present");
    expect(diagnostics).toContain("quotedMessageId=present(length=16)");
    expect(diagnostics).not.toContain("+15550000002");
    expect(diagnostics).not.toContain("SECRET_MARKER");
    expect(diagnostics).not.toContain("fresh-message-secret-id");
    expect(diagnostics).not.toContain("quoted-secret-id");
  });

  it("formats batch count diagnostics without exposing WhatsApp message content", () => {
    const diagnostics = testing.formatWhatsAppBatchMessageDiagnostics([
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "batch-secret-id",
        observedAt: "2026-06-05T01:00:01.000Z",
        quoted: { messageId: "quoted-secret-id", text: "quoted secret body" },
        text: "SECRET_BATCH_BODY",
      },
    ]);

    expect(diagnostics).toContain("textLength=17");
    expect(diagnostics).toContain("messageId=present(length=15)");
    expect(diagnostics).toContain("quoted=present");
    expect(diagnostics).not.toContain("+15550000002");
    expect(diagnostics).not.toContain("SECRET_BATCH_BODY");
    expect(diagnostics).not.toContain("batch-secret-id");
    expect(diagnostics).not.toContain("quoted secret body");
  });

  it("deduplicates WhatsApp batch observations by message id", () => {
    const messages = testing.dedupeWhatsAppMessagesById([
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "same-message-id",
        observedAt: "2026-06-05T01:00:01.000Z",
        text: "first observation",
      },
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        messageId: "same-message-id",
        observedAt: "2026-06-05T01:00:02.000Z",
        text: "duplicate observation",
      },
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        observedAt: "2026-06-05T01:00:03.000Z",
        text: "missing id stays distinct",
      },
      {
        fromPhoneE164: "+15550000002",
        kind: "text",
        observedAt: "2026-06-05T01:00:04.000Z",
        text: "second missing id stays distinct",
      },
    ]);

    expect(messages.map((message) => message.text)).toEqual([
      "first observation",
      "missing id stays distinct",
      "second missing id stays distinct",
    ]);
  });

  it("treats any fresh SUT message as unexpected for no-reply scenarios", () => {
    const unexpected = testing.findUnexpectedWhatsAppNoReplyMessage({
      messages: [
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          observedAt: "2026-06-05T00:59:59.000Z",
          text: "old generic access warning",
        },
        {
          fromPhoneE164: "+15550000003",
          kind: "text",
          observedAt: "2026-06-05T01:00:01.000Z",
          text: "unrelated peer message",
        },
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          observedAt: "2026-06-05T01:00:02.000Z",
          text: "generic access warning without the scenario marker",
        },
      ],
      observedAfter: new Date("2026-06-05T01:00:00.000Z"),
      sutPhoneE164: "+15550000002",
      target: "dm",
    });

    expect(unexpected?.text).toBe("generic access warning without the scenario marker");
  });

  it("does not treat the lower-bound SUT message as fresh in no-reply scenarios", () => {
    const unexpected = testing.findUnexpectedWhatsAppNoReplyMessage({
      messages: [
        {
          fromPhoneE164: "+15550000002",
          kind: "text",
          observedAt: "2026-06-05T01:00:00.000Z",
          text: "reply that triggered the quiet-window action",
        },
      ],
      observedAfter: new Date("2026-06-05T01:00:00.000Z"),
      sutPhoneE164: "+15550000002",
      target: "dm",
    });

    expect(unexpected).toBeUndefined();
  });

  it("treats any fresh group message as unexpected for group no-reply scenarios", () => {
    const unexpected = testing.findUnexpectedWhatsAppNoReplyMessage({
      groupJid: "120363000000000000@g.us",
      messages: [
        {
          fromJid: "120363111111111111@g.us",
          fromPhoneE164: null,
          kind: "text",
          observedAt: "2026-06-05T01:00:01.000Z",
          text: "different group message",
        },
        {
          fromJid: "120363000000000000@g.us",
          fromPhoneE164: null,
          kind: "text",
          observedAt: "2026-06-05T01:00:02.000Z",
          text: "generic group access warning without the scenario marker",
        },
      ],
      observedAfter: new Date("2026-06-05T01:00:00.000Z"),
      sutPhoneE164: "+15550000002",
      target: "group",
    });

    expect(unexpected?.text).toBe("generic group access warning without the scenario marker");
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

    expect(testing.findScenarios(undefined, "live-frontier").map(({ id }) => id)).toEqual(
      expectedDefaultIds,
    );
    expect(testing.findScenarios([], "live-frontier").map(({ id }) => id)).toEqual(
      expectedDefaultIds,
    );
  });

  it("adds deterministic audio preflight to the default mock-openai WhatsApp selection", () => {
    expect(testing.findScenarios(undefined, "mock-openai").map(({ id }) => id)).toEqual([
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
      expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
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
      expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
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
      expect(account?.groupPolicy).toBe("open");
      expect(account?.groups?.[groupJid]?.requireMention).toBe(true);
    }
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
    const scenarios = testing.findScenarios([
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
        standardId: scenario.standardId,
        target: run.target,
      })),
    ).toEqual([
      {
        id: "whatsapp-reply-to-message",
        requiresGroupJid: undefined,
        standardId: "quote-reply",
        target: "dm",
      },
      {
        id: "whatsapp-group-reply-to-message",
        requiresGroupJid: true,
        standardId: "quote-reply",
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

  it("formats approval wait diagnostics without exposing message content", () => {
    const observedAfter = new Date("2026-06-05T18:36:57.000Z");
    const diagnostics = testing.formatWhatsAppApprovalWaitDiagnostics({
      approvalId: "plugin:approval-1",
      approvalKind: "plugin",
      driver: createWhatsAppQaDriverMock({
        getObservedMessages: () => [
          {
            fromPhoneE164: "+15550000002",
            kind: "text",
            messageId: "message-1",
            observedAt: "2026-06-05T18:36:58.000Z",
            text: "unrelated text that should not be copied into diagnostics",
          },
        ],
      }),
      observedAfter,
      state: "pending",
      sutPhoneE164: "+15550000002",
      token: "TOKEN-1",
    });

    expect(diagnostics).toContain("observed 1 WhatsApp driver message(s)");
    expect(diagnostics).toContain("fromExpectedSut=yes");
    expect(diagnostics).toContain("approvalText=no");
    expect(diagnostics).toContain("messageId=present(length=9)");
    expect(diagnostics).not.toContain("unrelated text");
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

  it("formats per-scenario progress lines for live lane visibility", () => {
    const scenario = findWhatsAppScenario("whatsapp-inbound-structured-messages");
    if (!scenario) {
      throw new Error("missing structured WhatsApp scenario");
    }

    expect(
      testing.formatWhatsAppScenarioProgressLine({
        details: "timed out waiting for WhatsApp QA driver message",
        index: 21,
        scenario,
        status: "fail",
        total: 35,
      }),
    ).toBe(
      "[whatsapp-qa] [21/35] fail whatsapp-inbound-structured-messages: " +
        "WhatsApp inbound structured messages reach the agent - " +
        "timed out waiting for WhatsApp QA driver message",
    );
  });

  it("redacts per-scenario progress details when public metadata redaction is enabled", () => {
    expect(
      testing.formatWhatsAppScenarioProgressDetails({
        details: "long reply chunked across raw-message-id-1 and raw-message-id-2",
        redactMetadata: true,
      }),
    ).toBe("details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)");
    expect(
      testing.formatWhatsAppScenarioProgressDetails({
        details:
          "timed out waiting for WhatsApp QA driver message; observed 1 WhatsApp driver message(s) after wait lower bound: #1 observedAt=2026-06-04T23:47:00.000Z fromPhone=present kind=text textLength=17 messageId=present(length=10) quoted=missing quotedMessageId=missing fromExpectedSut=yes",
        redactMetadata: true,
      }),
    ).toBe(
      "observed 1 WhatsApp driver message(s) after wait lower bound: " +
        "#1 observedAt=2026-06-04T23:47:00.000Z fromPhone=present kind=text " +
        "textLength=17 messageId=present(length=10) quoted=missing " +
        "quotedMessageId=missing fromExpectedSut=yes",
    );
    expect(
      testing.formatWhatsAppScenarioProgressDetails({
        details:
          "timed out waiting for WhatsApp QA driver message; observed 0 WhatsApp driver message(s) after wait lower bound",
        redactMetadata: true,
      }),
    ).toBe("observed 0 WhatsApp driver message(s) after wait lower bound");
    expect(
      testing.formatWhatsAppScenarioProgressDetails({
        details: "safe local diagnostic",
        redactMetadata: false,
      }),
    ).toBe("safe local diagnostic");
  });

  it("defines WhatsApp final-message accounting as a settled two-chunk assertion", () => {
    const scenario = findWhatsAppScenario("whatsapp-stream-final-message-accounting");
    const run = scenario.buildRun();
    if (run.kind === "approval") {
      throw new Error("whatsapp-stream-final-message-accounting unexpectedly built approval run");
    }

    expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
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
    const scenarios = testing.findScenarios([
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
    expect(testing.WHATSAPP_QA_STANDARD_SCENARIO_IDS).not.toContain(
      "whatsapp-approval-exec-native",
    );
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
    expect(cfg.tools?.media?.audio).toEqual({
      enabled: true,
      models: [{ provider: "openai", model: "gpt-4o-transcribe" }],
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
    expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
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
        statusReactions: {
          removeAckAfterReply: true,
          timing: {
            debounceMs: 0,
            stallSoftMs: 60_000,
          },
        },
      },
    });

    expect(cfg.channels?.whatsapp?.accounts?.sut?.replyToMode).toBe("all");
    expect(cfg.channels?.whatsapp?.accounts?.sut?.debounceMs).toBe(250);
    expect(cfg.channels?.whatsapp?.ackReaction).toMatchObject({
      direct: true,
      emoji: "👀",
    });
    expect(cfg.messages?.removeAckAfterReply).toBe(true);
    expect(cfg.messages?.statusReactions?.enabled).toBe(true);
    expect(cfg.messages?.statusReactions?.timing).toMatchObject({
      debounceMs: 0,
      stallSoftMs: 60_000,
    });
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

  it("stages mock auth for WhatsApp broadcast scenario agents", () => {
    const scenarios = testing.findScenarios(["whatsapp-broadcast-group-fanout", "whatsapp-canary"]);
    const broadcastScenario = scenarios.find(({ id }) => id === "whatsapp-broadcast-group-fanout");
    const canaryScenario = scenarios.find(({ id }) => id === "whatsapp-canary");
    if (!broadcastScenario || !canaryScenario) {
      throw new Error("missing WhatsApp auth staging test scenario");
    }

    expect(testing.buildWhatsAppQaMockAuthAgentIds(broadcastScenario)).toEqual([
      "main",
      "qa",
      "qa-second",
    ]);
    expect(testing.buildWhatsAppQaMockAuthAgentIds(canaryScenario)).toEqual(["main", "qa"]);
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

  it("matches native approval resolved text emitted by the WhatsApp approval handler", () => {
    expect(
      testing.matchesWhatsAppApprovalResolvedText({
        approvalId: "whatsapp-qa-exec-123",
        approvalKind: "exec",
        text: "✅ Exec approval allow-once. ID: whatsapp-qa-exec-123",
      }),
    ).toBe(true);
    expect(
      testing.matchesWhatsAppApprovalResolvedText({
        approvalId: "whatsapp-qa-plugin-123",
        approvalKind: "plugin",
        text: "✅ Plugin approval allowed once. ID: whatsapp-qa-plugin-123",
      }),
    ).toBe(true);
    expect(
      testing.matchesWhatsAppApprovalResolvedText({
        approvalId: "whatsapp-qa-exec-deny-123",
        approvalKind: "exec",
        decision: "deny",
        text: "✅ Exec approval deny. ID: whatsapp-qa-exec-deny-123",
      }),
    ).toBe(true);
    expect(
      testing.matchesWhatsAppApprovalResolvedText({
        approvalId: "whatsapp-qa-plugin-deny-123",
        approvalKind: "plugin",
        decision: "deny",
        text: "✅ Plugin approval denied. ID: whatsapp-qa-plugin-deny-123",
      }),
    ).toBe(true);
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

  it("fails explicitly requested group scenarios when group credentials are missing", () => {
    const scenario = findWhatsAppScenario("whatsapp-mention-gating");

    const implicitResult = testing.createMissingGroupJidScenarioResult({
      explicitScenarioSelection: false,
      scenario,
    });
    expect(implicitResult.id).toBe("whatsapp-mention-gating");
    expect(implicitResult.status).toBe("skip");

    const explicitResult = testing.createMissingGroupJidScenarioResult({
      explicitScenarioSelection: true,
      scenario,
    });
    expect(explicitResult.id).toBe("whatsapp-mention-gating");
    expect(explicitResult.status).toBe("fail");
    expect(explicitResult.details).toContain("requested scenario requires groupJid");
  });

  it("attributes pre-scenario setup failures to the selected scenario", () => {
    const scenarios = testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioResults: Array<{
      details: string;
      id: string;
      posture: "direct-gateway" | "native-approval" | "user-path";
      status: "fail" | "pass" | "skip";
      title: string;
    }> = [];

    testing.appendPreScenarioFailureResults({
      details: "setup exploded",
      scenarioResults,
      scenarios,
    });

    expect(scenarioResults).toEqual([
      {
        id: "whatsapp-mention-gating",
        title: "WhatsApp group mention gating",
        standardId: "mention-gating",
        posture: "user-path",
        status: "fail",
        details: "setup exploded",
      },
    ]);
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
