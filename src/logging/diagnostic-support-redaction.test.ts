import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  redactSupportString,
  redactTextForSupport,
  sanitizeSupportConfigValue,
  sanitizeSupportSnapshotValue,
} from "./diagnostic-support-redaction.js";

function fakeAwsSecretAccessKey(): string {
  return fakeRepeatedToken(["A", "b", "9", "/"]);
}

function fakeAwsSecretAccessKeyWithPadding(): string {
  return fakeRepeatedToken(["A", "b", "9", "="]);
}

function fakeJwtAwsSecretShapedSegment(): string {
  return fakeRepeatedToken(["A", "b", "9", "C"]);
}

function fakeCommitHash(): string {
  return `${"0123456789abcdef".repeat(2)}01234567`;
}

function fakeLowercaseBase36Identifier(): string {
  return `${"z".repeat(39)}1`;
}

function fakeFlyTokenWithAwsShapedBody(): string {
  return `FlyV1 fm123_${fakeAwsSecretAccessKeyWithPadding()}_${"tail".repeat(20)}`;
}

function fakeCommaDelimitedFlyTokenWithAwsShapedBody(): string {
  return `FlyV1 fm123_headheadheadheadheadheadheadhead,${fakeAwsSecretAccessKeyWithPadding()},${"tail".repeat(20)}`;
}

function fakeRepeatedToken(chars: readonly string[], length = 40): string {
  return Array.from({ length }, (_entry, index) => chars[index % chars.length] ?? "A").join("");
}

describe("diagnostic support redaction", () => {
  const tempDir = path.join(os.tmpdir(), "openclaw-support-redaction-test");

  it("redacts numeric private fields in support snapshots and config", () => {
    const redaction = {
      env: {
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
    };

    expect(sanitizeSupportSnapshotValue(15555551212, redaction, "chatId")).toBe("<redacted>");
    expect(sanitizeSupportSnapshotValue(15555551212, redaction, "messageId")).toBe("<redacted>");
    expect(sanitizeSupportSnapshotValue(200, redaction, "statusCode")).toBe(200);
    expect(sanitizeSupportConfigValue(15555551212, redaction, "ownerId")).toBe("<redacted>");
    expect(sanitizeSupportConfigValue(18789, redaction, "port")).toBe(18789);
  });

  it("blocks prototype keys and caps support sanitizer width", () => {
    const redaction = {
      env: {
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
    };
    const wideSnapshot: Record<string, unknown> = {
      ["__proto__"]: "polluted",
      constructor: "polluted",
      prototype: "polluted",
    };
    for (let index = 0; index < 1005; index += 1) {
      wideSnapshot[`field${String(index).padStart(4, "0")}`] = index;
    }

    const snapshot = sanitizeSupportSnapshotValue(wideSnapshot, redaction) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(snapshot)).toBe(null);
    expect(Object.hasOwn(snapshot, "__proto__")).toBe(false);
    expect(snapshot.constructor).toBeUndefined();
    expect(snapshot.prototype).toBeUndefined();
    expect(snapshot.field0000).toBe(0);
    expect(snapshot.field0999).toBe(999);
    expect(snapshot.field1000).toBeUndefined();
    expect(snapshot["<truncated>"]).toEqual({
      truncated: true,
      count: 1008,
      limit: 1000,
    });

    const array = sanitizeSupportConfigValue(
      Array.from({ length: 1005 }, (_entry, index) => ({ name: `item-${index}` })),
      redaction,
    ) as Record<string, unknown>;

    expect(Array.isArray(array)).toBe(false);
    expect((array.items as unknown[]).length).toBe(1000);
    expect(array.truncated).toBe(true);
    expect(array.count).toBe(1005);
    expect(array.limit).toBe(1000);
  });

  it("redacts support text identifiers without hiding useful URL hosts", () => {
    const fakeAwsKey = ["ASIA", "IOSFODNN7EXAMPLE"].join("");
    const fakeAwsSecretKey = fakeAwsSecretAccessKey();
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiIs",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4i",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const jwtWithAwsSecretShapedSegment = [
      "eyJheaderabcd",
      fakeJwtAwsSecretShapedSegment(),
      "signatureabcd123456",
    ].join(".");
    const awsShapedDataUrl = `data:application/octet-stream;base64,${Array.from(
      { length: 40 },
      (_entry, index) => (["A", "b", "9", "+"] as const)[index % 4] ?? "A",
    ).join("")}`;
    const cases = [
      [
        "connect wss://support-user:support-password@gateway.example/ws?token=short-token&ok=1",
        "connect wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>&ok=1",
      ],
      [
        "connect https://gateway.example/ws?access-token=short-token",
        "connect https://gateway.example/ws?access-token=<redacted>",
      ],
      [
        "connect https://gateway.example/ws?hook-token=hook-secret",
        "connect https://gateway.example/ws?hook-token=<redacted>",
      ],
      ["connect https://token@gateway.example/ws", "connect https://<redacted>@gateway.example/ws"],
      ["auth Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "auth Basic <redacted>"],
      ["Cookie: sid=secret; theme=light", "Cookie: <redacted>"],
      [`aws ${fakeAwsKey}`, "aws <redacted-aws-key>"],
      [`aws secret ${fakeAwsSecretKey}`, "aws secret <redacted-aws-secret-key>"],
      [
        `aws padded secret ${fakeAwsSecretAccessKeyWithPadding()}`,
        "aws padded secret <redacted-aws-secret-key>",
      ],
      [`data ${awsShapedDataUrl}`, `data ${awsShapedDataUrl}`],
      [`jwt ${fakeJwt}`, "jwt <redacted-jwt>"],
      [`jwt ${jwtWithAwsSecretShapedSegment}`, "jwt <redacted-jwt>"],
      [`provider ${fakeFlyTokenWithAwsShapedBody()}`, "provider FlyV1 …tail"],
      [`provider ${fakeCommaDelimitedFlyTokenWithAwsShapedBody()}`, "provider FlyV1 …tail"],
      [`commit ${fakeCommitHash()}`, `commit ${fakeCommitHash()}`],
      [`id ${fakeLowercaseBase36Identifier()}`, `id ${fakeLowercaseBase36Identifier()}`],
      ["email alice@example.com", "email <redacted-email>"],
      ["matrix @support-user:matrix.example.com", "matrix <redacted-matrix-user>"],
      ["room !support-room:matrix.example.com", "room <redacted-matrix-room>"],
      ["event $F0Zlxky8bavuqH6MK75Av_c7UWFLp550WTQ1EA-F0KM", "event <redacted-matrix-event>"],
      ["event $UPPERCASEMATRIXEVENTID", "event <redacted-matrix-event>"],
      ["event $OPENCLAW_STATE_DIR_PRIVATE", "event <redacted-matrix-event>"],
      ["event $OPENCLAW_STATE_DIR1", "event <redacted-matrix-event>"],
      ["event $PREFIX_OPENCLAW_STATE_DIR", "event <redacted-matrix-event>"],
      ["notify @support_bot now", "notify <redacted-handle> now"],
      ["phone 15555551212", "phone <redacted-id>"],
      [
        `config password = ${["support", "password", "1234567890"].join("-")}`,
        "config password = suppor…7890",
      ],
      [
        ["config password", " = ", '"', ["support", "password", "1234567890"].join("-"), '"'].join(
          "",
        ),
        'config password = "suppor…7890"',
      ],
      [
        `config db_password = ${["support", "password", "1234567890"].join("-")}`,
        "config db_password = suppor…7890",
      ],
      [
        `config readonly_db_password = ${["support", "password", "1234567890"].join("-")}`,
        "config readonly_db_password = suppor…7890",
      ],
      [
        `config jdbc.password=${["support", "password", "1234567890"].join("-")}`,
        "config jdbc.password=suppor…7890",
      ],
    ] as const;

    for (const [input, expected] of cases) {
      expect(redactTextForSupport(input)).toBe(expected);
    }
  });

  it("preserves canonical state path markers across repeated support handoffs", () => {
    const redaction = { env: {}, stateDir: tempDir };
    const expected = "Config: $OPENCLAW_STATE_DIR/openclaw.json";
    const sanitized = redactSupportString(`Config: ${tempDir}/openclaw.json`, redaction);

    expect(sanitized).toBe(expected);
    expect(redactSupportString(sanitized, redaction)).toBe(expected);
    expect(redactSupportString("$OPENCLAW_STATE_DIR", redaction)).toBe("$OPENCLAW_STATE_DIR");
  });

  it("truncates support strings without splitting UTF-16 surrogate pairs", () => {
    const redaction = {
      env: {
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
    };
    const truncationSuffix = "...<truncated>";

    expect(redactSupportString("abcd😀tail", redaction, { maxLength: 5 })).toBe(
      `abcd${truncationSuffix}`,
    );

    const redactedPathPrefix = `$OPENCLAW_STATE_DIR${path.sep}`;
    expect(
      redactSupportString(path.join(tempDir, "abcd😀tail"), redaction, {
        maxLength: redactedPathPrefix.length + 5,
      }),
    ).toBe(`${redactedPathPrefix}abcd${truncationSuffix}`);
  });

  it("redacts Windows USERPROFILE paths when HOME is unset", () => {
    const userProfile = "C:\\Users\\support-user";
    const stateDir = `${userProfile}\\AppData\\Roaming\\openclaw`;
    const redaction = {
      env: {
        USERPROFILE: userProfile,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stateDir,
    };

    expect(redactSupportString(`${stateDir}\\logs\\gateway.log`, redaction)).toBe(
      "$OPENCLAW_STATE_DIR\\logs\\gateway.log",
    );
    expect(
      redactSupportString(`failed at ${userProfile}\\Documents\\snapshot-error.txt`, redaction),
    ).toBe("failed at ~\\Documents\\snapshot-error.txt");
    expect(
      redactSupportString(
        "failed at c:\\users\\support-user\\Documents\\snapshot-error.txt",
        redaction,
      ),
    ).toBe("failed at ~\\Documents\\snapshot-error.txt");

    const status = sanitizeSupportSnapshotValue(
      {
        service: {
          command: {
            programArguments: [
              "node",
              `${userProfile}\\openclaw\\dist\\index.js`,
              "--config",
              `${stateDir}\\openclaw.json`,
              `--aws-secret-access-key=${fakeAwsSecretAccessKey()}`,
              "--awsSecretAccessKey",
              fakeAwsSecretAccessKey(),
            ],
            sourcePath: "c:\\users\\support-user\\AppData\\Local\\openclaw\\gateway-service.json",
          },
        },
      },
      redaction,
    );
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("support-user");
    expect(serialized).not.toContain(fakeAwsSecretAccessKey());
    expect(serialized).toContain("~\\\\openclaw\\\\dist\\\\index.js");
    expect(serialized).toContain("$OPENCLAW_STATE_DIR\\\\openclaw.json");
    expect(serialized).toContain("--aws-secret-access-key=<redacted>");
    expect(serialized).toContain("--awsSecretAccessKey");
    expect(serialized).toContain("~\\\\AppData\\\\Local\\\\openclaw\\\\gateway-service.json");
  });
});
