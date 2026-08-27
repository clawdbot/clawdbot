import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapAuthResult } from "./imap-test-support.js";
import { renderImapPrompt } from "./prompt.js";
import { evaluateImapSender } from "./sender-gate.js";

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
  ])("matches sender %s against the actual addr-spec", async (sender, entries, accepted) => {
    const mail = await message([`From: ${sender}`, "To: reader@example.com"]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    const verdict = await evaluateImapSender({
      ...mail,
      account: account({ allowedSenders: entries }),
      authenticator,
    });
    expect(verdict.accepted).toBe(accepted);
    if (!accepted) {
      expect(verdict.reason).toBe("sender-not-allowed");
    }
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
    "never dispatches on DMARC %s at the default verified threshold",
    async (result) => {
      const mail = await message([
        "From: trusted@example.com",
        "To: reader+wrong-token@example.com",
      ]);
      const authentication =
        result === "neutral"
          ? createImapAuthResult(result)
          : await authenticate(mail.raw, {
              disableArc: true,
              disableBimi: true,
              resolver: async () => {
                if (result === "temperror") {
                  throw new Error("fixture DNS timeout");
                }
                return [];
              },
            });
      expect(authentication.dmarc).toMatchObject({ status: { result } });
      if (result !== "neutral") {
        expect(authentication.dmarc).not.toHaveProperty("alignment");
      }
      const configured = account({
        addressTokens: [{ token: "expected-token", senders: ["trusted@example.com"] }],
      });
      await expect(
        evaluateImapSender({
          ...mail,
          account: configured,
          authenticator: async () => authentication,
        }),
      ).resolves.toMatchObject({ accepted: false, transient: result === "temperror" });
    },
  );

  it.each(["pass", "fail"] as const)(
    "rejects unsigned body bytes even with DMARC %s",
    async (dmarc) => {
      const result = createImapAuthResult(dmarc);
      if (result.dmarc) {
        result.dmarc.alignment.dkim.underSized = 32;
      }
      const mail = await message(["From: trusted@example.com", "To: reader@example.com"]);
      const authenticator = vi.fn(async () => result);
      await expect(
        evaluateImapSender({ ...mail, account: account(), authenticator }),
      ).resolves.toMatchObject({ accepted: false, reason: "dkim-unsigned-body" });
    },
  );

  it("accepts only configured Authentication-Results authorities", async () => {
    const configured = account({
      senderAuth: {
        min: "asserted",
        trustedAuthservIds: ["mx.example.com"],
        acceptTrustedAuthservId: true,
      },
    });
    const authenticator = vi.fn(async () => createImapAuthResult("none"));
    const untrusted = await message([
      "From: trusted@example.com",
      "Authentication-Results: attacker.example; dmarc=pass",
    ]);
    await expect(
      evaluateImapSender({ ...untrusted, account: configured, authenticator }),
    ).resolves.toMatchObject({ accepted: false, reason: "unverified-authentication" });
    const trusted = await message([
      "From: trusted@example.com",
      "Authentication-Results: mx.example.com; dmarc=pass header.from=example.com",
    ]);
    await expect(
      evaluateImapSender({ ...trusted, account: configured, authenticator }),
    ).resolves.toMatchObject({
      accepted: true,
      strength: "asserted",
      reason: "trusted-authserv-dmarc-pass",
    });
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
