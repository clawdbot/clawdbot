import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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
            observedAt: "2026-05-04T12:00:00.000Z",
            text: "captured body",
          },
        ],
      }),
    ).toEqual([
      {
        observedAt: "2026-05-04T12:00:00.000Z",
        text: "captured body",
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
      "allowlist-block",
      "mention-gating",
    ]);
  });

  it("keeps native approval scenarios out of default WhatsApp selection", () => {
    const expectedDefaultIds = [
      "whatsapp-canary",
      "whatsapp-pairing-block",
      "whatsapp-mention-gating",
    ];

    expect(testing.findScenarios().map(({ id }) => id)).toEqual(expectedDefaultIds);
    expect(testing.findScenarios([]).map(({ id }) => id)).toEqual(expectedDefaultIds);
  });

  it("selects native approval scenarios by id without changing standard coverage", () => {
    const scenarios = testing.findScenarios([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-plugin-native",
    ]);

    expect(scenarios.map(({ id }) => id)).toEqual([
      "whatsapp-approval-exec-native",
      "whatsapp-approval-plugin-native",
    ]);
    expect(testing.WHATSAPP_QA_STANDARD_SCENARIO_IDS).not.toContain(
      "whatsapp-approval-exec-native",
    );
    expect(scenarios.map((scenario) => scenario.buildRun().kind)).toEqual(["approval", "approval"]);
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
        new Error("timed out waiting for WhatsApp QA driver message"),
      ),
    ).toBe(true);
    expect(testing.isTransientWhatsAppQaDriverError(new Error("timed out waiting"))).toBe(false);
  });
});
