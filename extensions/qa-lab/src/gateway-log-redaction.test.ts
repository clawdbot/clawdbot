import { describe, expect, it } from "vitest";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";

describe("gateway log redaction", () => {
  it("redacts raw Telegram bot tokens and Bot API URLs", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const raw = [
      `gateway echoed ${token}`,
      `POST https://api.telegram.org/bot${token}/sendMessage`,
    ].join("\n");

    const redacted = redactQaGatewayDebugText(raw);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("gateway echoed 123456…cdef");
    expect(redacted).toContain("https://api.telegram.org/bot123456…cdef/sendMessage");
    expect(formatQaGatewayLogsForError(raw)).not.toContain(token);
  });

  it("redacts Telegram bot tokens that cross the bounded-redactor chunk boundary", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const prefix = `${"x".repeat(16_384 - 5)} `;
    const raw = `${prefix}${token} ${"x".repeat(16_384)}`;

    expect(redactQaGatewayDebugText(raw)).not.toContain(token);
    expect(redactQaGatewayDebugText(raw)).toContain("123456…cdef");
    expect(formatQaGatewayLogsForError(raw)).not.toContain(token);
  });

  it("neutralizes GitHub workflow commands at every line boundary", () => {
    const raw = [
      "::set-output name=output_dir::/tmp/attacker",
      "safe",
      "\r::stop-commands::attacker-token",
      " \t::error::whitespace-prefixed",
      "\u00a0::warning::nbsp-prefixed",
      "\uFEFF::notice::bom-prefixed",
      "\u000b::debug::vertical-tab-prefixed",
      "\u000c::error::form-feed-prefixed",
      "\u2028::warning::line-separator-prefixed",
      "\u2029::notice::paragraph-separator-prefixed",
      "prefix ##[error]legacy command",
    ].join("\n");

    expect(redactQaGatewayDebugText(raw)).toBe(
      [
        ": :set-output name=output_dir::/tmp/attacker",
        "safe",
        "\r: :stop-commands::attacker-token",
        " \t: :error::whitespace-prefixed",
        "\u00a0: :warning::nbsp-prefixed",
        "\uFEFF: :notice::bom-prefixed",
        "\u000b: :debug::vertical-tab-prefixed",
        "\u000c: :error::form-feed-prefixed",
        "\u2028: :warning::line-separator-prefixed",
        "\u2029: :notice::paragraph-separator-prefixed",
        "prefix # #[error]legacy command",
      ].join("\n"),
    );
    expect(formatQaGatewayLogsForError(raw)).not.toMatch(/(^|[\r\n])[^\S\r\n]*::/u);
    expect(formatQaGatewayLogsForError(raw)).not.toContain("##[");
  });
});
