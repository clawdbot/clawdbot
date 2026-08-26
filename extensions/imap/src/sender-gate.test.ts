import { simpleParser } from "mailparser";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapAuthResult } from "./imap-test-support.js";
import { renderImapPrompt } from "./prompt.js";
import {
  evaluateImapSender,
  mapImapAuthStrength,
  matchesImapSender,
  parseImapAuthResults,
} from "./sender-gate.js";

function account(overrides: Record<string, unknown> = {}) {
  return resolveImapConfig({
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "test-password",
        agentId: "mail_reader",
        allowedSenders: ["trusted@example.com"],
        ...overrides,
      },
    },
  }).accounts.inbox!;
}

async function message(headers: string[], body = "Hello from a trusted sender") {
  const raw = Buffer.from([...headers, "", body].join("\r\n"));
  return { raw, mail: await simpleParser(raw), internalDate: new Date() };
}

describe("IMAP sender admission", () => {
  it.each([
    ["trusted@EXAMPLE.com", ["trusted@example.COM"], true],
    ["person@example.com", ["@EXAMPLE.com"], true],
    ["trusted@evil.example", ["trusted@example.com"], false],
    ["Trusted@example.com", ["trusted@example.com"], false],
  ])("matches sender %s against the actual addr-spec", (sender, entries, accepted) => {
    expect(matchesImapSender(sender, entries)).toBe(accepted);
  });

  it("rejects a spoofed display name and ignores Reply-To", async () => {
    const mail = await message([
      'From: "trusted@example.com" <attacker@evil.example>',
      "Reply-To: trusted@example.com",
      "To: reader@example.com",
    ]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    await expect(
      evaluateImapSender({ ...mail, account: account(), authenticator }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "sender-not-allowed",
    });
    expect(authenticator).not.toHaveBeenCalled();
  });

  it.each([
    ["From: trusted@example.com, attacker@evil.example"],
    ["From: attacker@evil.example", "From: trusted@example.com"],
  ])("rejects multi-From messages before authentication", async (...headers) => {
    const mail = await message(headers);
    await expect(evaluateImapSender({ ...mail, account: account() })).resolves.toMatchObject({
      accepted: false,
      reason: "invalid-from",
    });
  });

  it.each(["neutral", "temperror", "none"] as const)(
    "never treats DMARC %s as verified",
    (result) => {
      expect(mapImapAuthStrength(createImapAuthResult(result), [], account()).strength).not.toBe(
        "verified",
      );
    },
  );

  it("does not verify a passing DKIM signature that left message body bytes unsigned", () => {
    const result = createImapAuthResult("pass");
    if (result.dmarc) {
      result.dmarc.alignment.dkim.underSized = 32;
    }
    expect(mapImapAuthStrength(result, [], account()).strength).not.toBe("verified");
  });

  it("accepts only configured Authentication-Results authorities", () => {
    const configured = account({
      senderAuth: {
        min: "asserted",
        trustedAuthservIds: ["mx.example.com"],
        acceptTrustedAuthservId: true,
      },
    });
    expect(parseImapAuthResults("mx.example.com; dmarc=pass header.from=example.com")).toEqual({
      authservId: "mx.example.com",
      dmarc: "pass",
    });
    expect(
      mapImapAuthStrength(
        createImapAuthResult("none"),
        [{ authservId: "evil.example", dmarc: "pass" }],
        configured,
      ),
    ).toMatchObject({ strength: "unverified" });
    expect(
      mapImapAuthStrength(
        createImapAuthResult("none"),
        [{ authservId: "mx.example.com", dmarc: "pass" }],
        configured,
      ),
    ).toMatchObject({ strength: "asserted" });
  });

  it("binds plus-address tokens to an already-allowed sender", async () => {
    const configured = account({
      addressTokens: [{ token: "secret-token", senders: ["trusted@example.com"] }],
    });
    const accepted = await message([
      "From: trusted@example.com",
      "To: reader+secret-token@example.com",
    ]);
    await expect(evaluateImapSender({ ...accepted, account: configured })).resolves.toMatchObject({
      accepted: true,
      strength: "mutable",
      reason: "token",
    });
    const rejected = await message([
      "From: attacker@evil.example",
      "To: reader+secret-token@example.com",
    ]);
    await expect(evaluateImapSender({ ...rejected, account: configured })).resolves.toMatchObject({
      accepted: false,
      reason: "sender-not-allowed",
    });
  });

  it("uses only an explicitly trusted Authentication-Results header when DNS verification fails", async () => {
    const configured = account({
      senderAuth: {
        min: "asserted",
        trustedAuthservIds: ["mx.example.com"],
        acceptTrustedAuthservId: true,
      },
    });
    const parsed = await message([
      "From: trusted@example.com",
      "Authentication-Results: attacker.example; dmarc=pass",
      "Authentication-Results: mx.example.com; dmarc=pass header.from=example.com",
    ]);
    const authenticator = vi.fn(async () => {
      throw new Error("DNS timeout");
    });
    await expect(
      evaluateImapSender({ ...parsed, account: configured, authenticator }),
    ).resolves.toMatchObject({
      accepted: true,
      strength: "asserted",
      reason: "trusted-authserv-dmarc-pass",
    });
  });

  it("caps rendered prompts and records truncation", async () => {
    const parsed = await message(["From: trusted@example.com", "Subject: Large"], "🙂".repeat(500));
    const prompt = renderImapPrompt(parsed.mail, { includeBody: true, maxBytes: 256 });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(256);
    expect(prompt).toContain("[truncated:");
  });
});
