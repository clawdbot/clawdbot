// Qa Lab tests cover whatsapp live plugin behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";
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

  it("redacts published scenario details before rendering public artifacts", () => {
    const publishedScenarios = testing.redactWhatsAppQaScenarioResults([
      {
        id: "whatsapp-reply-delivery-shape",
        title: "WhatsApp gateway send chunks long replies",
        status: "pass",
        details: "long reply chunked across raw-message-id-1 and raw-message-id-2",
      },
      {
        id: "whatsapp-inbound-structured-messages",
        title: "WhatsApp inbound structured messages reach the agent",
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

  it("rejects unsafe archive entries before extraction", () => {
    expect(() => testing.assertSafeArchiveEntries(["../creds.json"])).toThrow("unsafe entry");
    expect(() => testing.assertSafeArchiveEntries(["/tmp/creds.json"])).toThrow("unsafe entry");
  });

  it("registers the WhatsApp canary and pairing scenarios", () => {
    const scenarios = testing.findScenarios(["whatsapp-canary", "whatsapp-pairing-block"]);
    expect(scenarios.map(({ id }) => id)).toEqual(["whatsapp-canary", "whatsapp-pairing-block"]);
  });

  it("reports standard WhatsApp live transport scenario coverage", () => {
    expect(testing.WHATSAPP_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "top-level-reply-shape",
      "restart-resume",
      "help-command",
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
      "whatsapp-pairing-block",
      "whatsapp-mention-gating",
      "whatsapp-top-level-reply-shape",
      "whatsapp-restart-resume",
      "whatsapp-help-command",
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
      "whatsapp-pairing-block",
      "whatsapp-mention-gating",
      "whatsapp-top-level-reply-shape",
      "whatsapp-restart-resume",
      "whatsapp-help-command",
      "whatsapp-commands-command",
      "whatsapp-tools-compact-command",
      "whatsapp-whoami-command",
      "whatsapp-context-command",
      "whatsapp-tool-only-usage-footer",
      "whatsapp-reply-context-isolation",
      "whatsapp-inbound-image-caption",
      "whatsapp-audio-preflight",
      "whatsapp-outbound-media-matrix",
      "whatsapp-outbound-document-preserves-filename",
      "whatsapp-outbound-poll",
      "whatsapp-message-actions",
      "whatsapp-inbound-structured-messages",
      "whatsapp-group-audio-gating",
      "whatsapp-access-control-dm-open",
      "whatsapp-access-control-dm-disabled",
      "whatsapp-access-control-group-open",
      "whatsapp-access-control-group-disabled",
      "whatsapp-reply-delivery-shape",
      "whatsapp-stream-final-message-accounting",
      "whatsapp-native-new-command",
      "whatsapp-status-reactions",
      "whatsapp-group-allowlist-block",
    ]);
  });

  it("seeds the structured-message location check through text context", () => {
    const [scenario] = testing.findScenarios(["whatsapp-inbound-structured-messages"]);
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

  it("formats per-scenario progress lines for live lane visibility", () => {
    const [scenario] = testing.findScenarios(["whatsapp-inbound-structured-messages"]);
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
        details: "safe local diagnostic",
        redactMetadata: false,
      }),
    ).toBe("safe local diagnostic");
  });

  it("adds WhatsApp command UX parity scenarios to the mock-backed selection", () => {
    const scenarios = testing.findScenarios([
      "whatsapp-commands-command",
      "whatsapp-tools-compact-command",
      "whatsapp-whoami-command",
      "whatsapp-context-command",
      "whatsapp-tool-only-usage-footer",
    ]);

    expect(
      scenarios.map((scenario) => {
        const run = scenario.buildRun();
        if (run.kind === "approval") {
          throw new Error(`${scenario.id} unexpectedly built an approval run`);
        }
        return [
          scenario.id,
          run.input,
          String(run.matchText),
          run.expectedJoinedSutTextIncludes,
          run.expectedSutMessageCountRange,
        ] as const;
      }),
    ).toEqual([
      [
        "whatsapp-commands-command",
        "/commands",
        "/Commands \\(|\\/session|\\/verbose/iu",
        ["/session", "/verbose"],
        undefined,
      ],
      [
        "whatsapp-tools-compact-command",
        "/tools compact",
        "/Available tools|exec|Use \\/tools verbose for descriptions/iu",
        ["exec", "Use /tools verbose for descriptions"],
        undefined,
      ],
      [
        "whatsapp-whoami-command",
        "/whoami",
        "/(?=.*Identity)(?=.*Channel: whatsapp)(?=.*AllowFrom:)/isu",
        undefined,
        undefined,
      ],
      [
        "whatsapp-context-command",
        "/context list",
        "/(?=.*Context breakdown)(?=.*Workspace:)(?=.*Tool schemas)/isu",
        undefined,
        undefined,
      ],
      [
        "whatsapp-tool-only-usage-footer",
        "/usage tokens",
        "/Usage footer: tokens/iu",
        undefined,
        undefined,
      ],
    ]);
    expect(scenarios.map((scenario) => scenario.defaultProviderModes)).toEqual([
      ["mock-openai"],
      ["mock-openai"],
      ["mock-openai"],
      ["mock-openai"],
      ["mock-openai"],
    ]);
  });

  it("defines WhatsApp final-message accounting as a settled two-chunk assertion", () => {
    const [scenario] = testing.findScenarios(["whatsapp-stream-final-message-accounting"]);
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
    const [scenario] = testing.findScenarios(["whatsapp-reply-delivery-shape"]);
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
            observedAt: "2026-06-05T01:00:01.000Z",
            text: `${token}_LONG_BEGIN`,
          };
          expect(params.match(firstChunk)).toBe(true);
          return firstChunk;
        }

        const missingTailMarker = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "chunk-2",
          observedAt: "2026-06-05T01:00:02.000Z",
          text: "second chunk without the tail marker",
        };
        const tailChunk = {
          fromPhoneE164: "+15550000002",
          kind: "text" as const,
          messageId: "chunk-3",
          observedAt: "2026-06-05T01:00:03.000Z",
          text: `${token}_LONG_END`,
        };
        expect(params.match(missingTailMarker)).toBe(false);
        expect(params.match(tailChunk)).toBe(true);
        return tailChunk;
      },
    });
    const context = {
      driver,
      driverPhoneE164: "+15550000001",
      gateway: {
        call: async () => ({}),
        restart: async () => {},
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      },
      gatewayTarget: "+15550000001",
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      recordObservedMessage: () => {},
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-reply-delivery-shape",
      scenarioTitle: "WhatsApp gateway send chunks long replies",
      sent: { messageId: "driver-message-1" },
      sutAccountId: "sut",
      sutPhoneE164: "+15550000002",
      target: "+15550000002",
      waitForReady: async () => {},
    } satisfies Parameters<NonNullable<typeof run.afterReply>>[1];

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

  it("selects native approval scenarios by id without changing standard coverage", () => {
    const scenarios = testing.findScenarios([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-exec-reaction-native",
      "whatsapp-approval-plugin-native",
    ]);

    expect(scenarios.map(({ id }) => id)).toEqual([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-exec-reaction-native",
      "whatsapp-approval-plugin-native",
    ]);
    expect(testing.WHATSAPP_QA_STANDARD_SCENARIO_IDS).not.toContain(
      "whatsapp-approval-exec-native",
    );
    expect(scenarios.map((scenario) => scenario.buildRun().kind)).toEqual([
      "approval",
      "approval",
      "approval",
    ]);
    expect(scenarios[1]?.buildRun()).toMatchObject({
      decisionMode: "reaction",
    });
  });

  it("enables WhatsApp native exec and plugin approval delivery for approval scenarios", () => {
    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        overrides: {
          approvals: {
            exec: true,
            plugin: true,
          },
        },
        sutAccountId: "sut",
      },
    );

    expect(cfg.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const account = cfg.channels?.whatsapp?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["+15550000001"]);
    expect(account).not.toHaveProperty("execApprovals");
  });

  it("enables WhatsApp audio preflight with the OpenAI transcription provider", () => {
    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        overrides: {
          audioPreflight: true,
        },
        sutAccountId: "sut",
      },
    );

    expect(cfg.plugins?.allow).toContain("whatsapp");
    expect(cfg.tools?.media?.audio).toEqual({
      enabled: true,
      models: [{ provider: "openai", model: "gpt-4o-transcribe" }],
    });
  });

  it("enables WhatsApp action discovery for message action scenarios", () => {
    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        overrides: {
          actions: true,
        },
        sutAccountId: "sut",
      },
    );

    expect(cfg.channels?.whatsapp?.actions).toEqual({ reactions: true, polls: true });
    expect(cfg.channels?.whatsapp?.reactionLevel).toBe("minimal");
  });

  it("defines the WhatsApp audio preflight scenario as mock-backed audio media", () => {
    const [scenario] = testing.findScenarios(["whatsapp-audio-preflight"]);
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-audio-preflight unexpectedly built an approval scenario run");
    }

    expect(scenario.requiredPluginIds).toEqual(["openai"]);
    expect(scenario.defaultProviderModes).toEqual(["mock-openai"]);
    expect(scenarioRun.expectReply).toBe(true);
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-audio.wav",
      kind: "media",
      mediaType: "audio/wav",
    });
    expect(scenarioRun.sendMode?.kind === "media" && scenarioRun.sendMode.mediaBuffer.length).toBe(
      32_044,
    );
  });

  it("defines group audio gating as captionless audio driven by mock transcription", () => {
    const [scenario] = testing.findScenarios(["whatsapp-group-audio-gating"]);
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-group-audio-gating unexpectedly built an approval scenario run");
    }

    expect(scenarioRun.input).toBe("");
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.quietInput).toBe("");
    expect(scenarioRun.quietMatchText).toBeUndefined();
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio.wav",
      kind: "media",
      mediaType: "audio/wav",
    });
    expect(scenarioRun.quietSendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio-quiet.wav",
      kind: "media",
      mediaType: "audio/wav",
    });
    expect(
      scenarioRun.sendMode?.kind === "media" &&
        scenarioRun.quietSendMode?.kind === "media" &&
        scenarioRun.sendMode.mediaBuffer.length > scenarioRun.quietSendMode.mediaBuffer.length,
    ).toBe(true);
  });

  it("applies WhatsApp QA config overrides for reply mode and status reactions", () => {
    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        overrides: {
          replyToMode: "all",
          statusReactions: true,
        },
        sutAccountId: "sut",
      },
    );

    expect(cfg.channels?.whatsapp?.accounts?.sut?.replyToMode).toBe("all");
    expect(cfg.channels?.whatsapp?.ackReaction).toMatchObject({
      direct: true,
      emoji: "👀",
    });
    expect(cfg.messages?.statusReactions?.enabled).toBe(true);
  });

  it("can configure a group scenario as sender allowlist-blocked instead of open mention-gated", () => {
    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000000"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        groupJid: "120363000000000000@g.us",
        overrides: {
          blockGroupSender: true,
          groupPolicy: "allowlist",
        },
        sutAccountId: "sut",
      },
    );

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
    const [scenario] = testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioRun = scenario.buildRun();
    if (scenarioRun.kind === "approval") {
      throw new Error("whatsapp-mention-gating unexpectedly built an approval scenario run");
    }
    expect(scenarioRun.input).toContain("openclawqa reply with only this exact marker");
    expect(scenarioRun.input).not.toContain("visible reply tool check");

    const cfg = testing.buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        groupJid: "120363000000000000@g.us",
        sutAccountId: "sut",
      },
    );
    expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(cfg.messages?.groupChat?.mentionPatterns).toContain("\\bopenclawqa\\b");
  });

  it("fails explicitly requested group scenarios when group credentials are missing", () => {
    const [scenario] = testing.findScenarios(["whatsapp-mention-gating"]);

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
