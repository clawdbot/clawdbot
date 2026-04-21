import { describe, expect, it } from "vitest";
import { IrcConfigSchema } from "./config-schema.js";

function expectValidConfig(result: ReturnType<typeof IrcConfigSchema.safeParse>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to be valid");
  }
  return result.data;
}

function expectInvalidConfig(result: ReturnType<typeof IrcConfigSchema.safeParse>) {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected config to be invalid");
  }
  return result.error.issues;
}

describe("irc config schema", () => {
  it("accepts basic config", () => {
    const config = expectValidConfig(
      IrcConfigSchema.safeParse({
        host: "irc.libera.chat",
        nick: "openclaw-bot",
        channels: ["#openclaw"],
      }),
    );

    expect(config.host).toBe("irc.libera.chat");
    expect(config.nick).toBe("openclaw-bot");
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidConfig(
      IrcConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["alice"],
      }),
    );

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const config = expectValidConfig(
      IrcConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    );

    expect(config.dmPolicy).toBe("open");
  });

  it("accepts numeric allowFrom and groupAllowFrom entries", () => {
    const parsed = IrcConfigSchema.parse({
      dmPolicy: "allowlist",
      allowFrom: [12345, "alice"],
      groupAllowFrom: [67890, "alice!ident@example.org"],
    });

    expect(parsed.allowFrom).toEqual([12345, "alice"]);
    expect(parsed.groupAllowFrom).toEqual([67890, "alice!ident@example.org"]);
  });

  it("accepts numeric per-channel allowFrom entries", () => {
    const parsed = IrcConfigSchema.parse({
      groups: {
        "#ops": {
          allowFrom: [42, "alice"],
        },
      },
    });

    expect(parsed.groups?.["#ops"]?.allowFrom).toEqual([42, "alice"]);
  });

  it("rejects nickserv register without registerEmail", () => {
    const issues = expectInvalidConfig(
      IrcConfigSchema.safeParse({
        nickserv: {
          register: true,
          password: "secret",
        },
      }),
    );

    expect(issues[0]?.path.join(".")).toBe("nickserv.registerEmail");
  });

  it("accepts nickserv register with password and registerEmail", () => {
    const config = expectValidConfig(
      IrcConfigSchema.safeParse({
        nickserv: {
          register: true,
          password: "secret",
          registerEmail: "bot@example.com",
        },
      }),
    );

    expect(config.nickserv?.register).toBe(true);
  });

  it("accepts nickserv register with registerEmail only", () => {
    expectValidConfig(
      IrcConfigSchema.safeParse({
        nickserv: {
          register: true,
          registerEmail: "bot@example.com",
        },
      }),
    );
  });
});
