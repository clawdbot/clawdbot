import AjvPkg from "ajv";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { describe, expect, it } from "vitest";
import { TwitchConfigSchema } from "./config-schema.js";

function validateTwitchConfig(value: unknown): boolean {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const schema = buildChannelConfigSchema(TwitchConfigSchema).schema;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const ok = validate(value);
  if (!ok) {
    throw new Error(`expected valid Twitch config: ${JSON.stringify(validate.errors)}`);
  }
  return true;
}

describe("TwitchConfigSchema JSON schema", () => {
  it("accepts single-account channel config with base fields", () => {
    expect(
      validateTwitchConfig({
        enabled: false,
        username: "openclaw",
        accessToken: "oauth:test",
        clientId: "test-client-id",
        channel: "openclaw-test",
      }),
    ).toBe(true);
  });

  it("accepts multi-account channel config with defaultAccount", () => {
    expect(
      validateTwitchConfig({
        enabled: true,
        defaultAccount: "stream",
        accounts: {
          stream: {
            username: "openclaw",
            accessToken: "oauth:test",
            clientId: "test-client-id",
            channel: "openclaw-test",
          },
        },
      }),
    ).toBe(true);
  });
});
