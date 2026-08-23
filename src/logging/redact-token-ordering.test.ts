// Redaction ordering tests cover generic credential patterns around whole-token redaction.
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

function fakeJwtCredentialShapedSegment(): string {
  return fakeRepeatedToken(["A", "b", "9", "C"]);
}

function fakeAwsCredentialWithPadding(): string {
  return fakeRepeatedToken(["A", "b", "9", "="]);
}

function fakeCommitHash(): string {
  return `${"0123456789abcdef".repeat(2)}01234567`;
}

function fakeLowercaseBase36Identifier(): string {
  return `${"z".repeat(39)}1`;
}

function fakeFlyTokenWithAwsShapedBody(): string {
  return `FlyV1 fm123_${fakeAwsCredentialWithPadding()}_${"tail".repeat(20)}`;
}

function fakeRepeatedToken(chars: readonly string[], length = 40): string {
  return Array.from({ length }, (_entry, index) => chars[index % chars.length] ?? "A").join("");
}

function fakeBase64LikePayload(length: number): string {
  return fakeRepeatedToken(["A", "b", "9", "+"], length);
}

describe("redactSensitiveText token ordering", () => {
  it("masks AWS secret access keys containing padding characters", () => {
    const secret = fakeAwsCredentialWithPadding();
    const output = redactSensitiveText(`aws_secret_access_key = ${secret}\nbare ${secret}`, {
      mode: "tools",
    });

    expect(output).not.toContain(secret);
    expect(output).toContain("aws_secret_access_key = ");
    expect(output).toContain("bare ");
  });

  it("masks a full JWT before generic bare credential matching", () => {
    const jwtSegment = fakeJwtCredentialShapedSegment();
    const jwt = `eyJheaderabcd.${jwtSegment}.signatureabcd123456`;
    const output = redactSensitiveText(`jwt ${jwt}`, { mode: "tools" });

    expect(output).not.toContain(jwtSegment);
    expect(output).not.toContain("signatureabcd123456");
    expect(output).toBe("jwt eyJhea…3456");
  });

  it("does not mask ordinary 40-character hex identifiers", () => {
    const commitHash = fakeCommitHash();
    expect(redactSensitiveText(`commit ${commitHash}`, { mode: "tools" })).toBe(
      `commit ${commitHash}`,
    );
  });

  it("does not mask ordinary lowercase 40-character alphanumeric identifiers", () => {
    const identifier = fakeLowercaseBase36Identifier();
    expect(redactSensitiveText(`id ${identifier}`, { mode: "tools" })).toBe(`id ${identifier}`);
  });

  it("masks full provider tokens before generic AWS-shaped chunks", () => {
    const token = fakeFlyTokenWithAwsShapedBody();
    const output = redactSensitiveText(`provider ${token}`, { mode: "tools" });

    expect(output).toBe("provider FlyV1 …tail");
    expect(output).not.toContain(token);
    expect(output).not.toContain("_tailtail");
  });

  it("does not mask AWS-shaped chunks inside longer base64-like payloads", () => {
    const payload = fakeBase64LikePayload(2048);
    expect(redactSensitiveText(`payload ${payload}`, { mode: "tools" })).toBe(`payload ${payload}`);
  });

  it("does not mask AWS-shaped chunks inside data URLs", () => {
    const dataUrl = `data:application/octet-stream;base64,${fakeBase64LikePayload(40)}`;
    expect(redactSensitiveText(dataUrl, { mode: "tools" })).toBe(dataUrl);
  });

  it("masks encoded AWS secret access key aliases", () => {
    const secret = fakeAwsCredentialWithPadding();
    const output = redactSensitiveText(
      [
        `https://x.test/?Secret%41ccessKey=${secret}`,
        `body=ok&aws%53ecretAccessKey=${secret}`,
      ].join("\n"),
      { mode: "tools" },
    );

    expect(output).not.toContain(secret);
    expect(output).toContain("Secret%41ccessKey=");
    expect(output).toContain("aws%53ecretAccessKey=");
  });
});
