import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { __testing } from "./whatsapp-live.runtime.js";

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
    expect(
      __testing.parseWhatsAppQaCredentialPayload({
        driverPhoneE164: "15550000001",
        sutPhoneE164: "+15550000002",
        driverAuthArchiveBase64: "driver",
        sutAuthArchiveBase64: "sut",
      }),
    ).toMatchObject({
      driverPhoneE164: "+15550000001",
      sutPhoneE164: "+15550000002",
      driverAuthArchiveBase64: "driver",
      sutAuthArchiveBase64: "sut",
    });
  });

  it("rejects credential payloads that reuse the same phone", () => {
    expect(() =>
      __testing.parseWhatsAppQaCredentialPayload({
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000001",
        driverAuthArchiveBase64: "driver",
        sutAuthArchiveBase64: "sut",
      }),
    ).toThrow("requires two distinct WhatsApp phone numbers");
  });

  it("redacts observed message content and phone metadata by default", () => {
    expect(
      __testing.toObservedWhatsAppArtifacts({
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
      __testing.toObservedWhatsAppArtifacts({
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
      const authDir = await __testing.unpackWhatsAppAuthArchive({
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
    expect(() => __testing.assertSafeArchiveEntries(["../creds.json"])).toThrow("unsafe entry");
    expect(() => __testing.assertSafeArchiveEntries(["/tmp/creds.json"])).toThrow("unsafe entry");
  });

  it("registers the WhatsApp canary and pairing scenarios", () => {
    expect(__testing.findScenarios(["whatsapp-canary", "whatsapp-pairing-block"])).toMatchObject([
      { id: "whatsapp-canary" },
      { id: "whatsapp-pairing-block" },
    ]);
  });

  it("uses automatic visible replies for WhatsApp group mention gating", () => {
    const [scenario] = __testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioRun = scenario.buildRun();
    expect(scenarioRun.input).toContain("openclawqa reply with only this exact marker");
    expect(scenarioRun.input).not.toContain("visible reply tool check");

    const cfg = __testing.buildWhatsAppQaConfig(
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
    const [scenario] = __testing.findScenarios(["whatsapp-mention-gating"]);

    expect(
      __testing.createMissingGroupJidScenarioResult({
        explicitScenarioSelection: false,
        scenario,
      }),
    ).toMatchObject({
      id: "whatsapp-mention-gating",
      status: "skip",
    });

    expect(
      __testing.createMissingGroupJidScenarioResult({
        explicitScenarioSelection: true,
        scenario,
      }),
    ).toMatchObject({
      id: "whatsapp-mention-gating",
      status: "fail",
      details: expect.stringContaining("requested scenario requires groupJid"),
    });
  });

  it("attributes pre-scenario setup failures to the selected scenario", () => {
    const scenarios = __testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioResults: Array<{
      details: string;
      id: string;
      status: "fail" | "pass" | "skip";
      title: string;
    }> = [];

    __testing.appendPreScenarioFailureResults({
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
});
