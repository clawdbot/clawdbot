import { describe, expect, it } from "vitest";
import { createChannelSecretTargetRegistryEntries } from "./channel-secret-basic-runtime.js";

describe("createChannelSecretTargetRegistryEntries", () => {
  it("builds account and channel SecretInput targets with fixed registry metadata", () => {
    expect(
      createChannelSecretTargetRegistryEntries({
        channelKey: "example",
        account: ["token"],
        channel: ["token"],
      }),
    ).toEqual([
      {
        id: "channels.example.accounts.*.token",
        targetType: "channels.example.accounts.*.token",
        configFile: "openclaw.json",
        pathPattern: "channels.example.accounts.*.token",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
      {
        id: "channels.example.token",
        targetType: "channels.example.token",
        configFile: "openclaw.json",
        pathPattern: "channels.example.token",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    ]);
  });

  it("supports sibling refs and CLI target aliases", () => {
    expect(
      createChannelSecretTargetRegistryEntries({
        channelKey: "example",
        account: [
          {
            path: "credentials",
            refPath: "credentialsRef",
            targetType: "channels.example.credentials",
            targetTypeAliases: ["channels.example.accounts.*.credentials"],
            secretShape: "sibling_ref",
            expectedResolvedValue: "string-or-object",
            accountIdPathSegmentIndex: 3,
          },
        ],
      })[0],
    ).toMatchObject({
      id: "channels.example.accounts.*.credentials",
      targetType: "channels.example.credentials",
      targetTypeAliases: ["channels.example.accounts.*.credentials"],
      pathPattern: "channels.example.accounts.*.credentials",
      refPathPattern: "channels.example.accounts.*.credentialsRef",
      secretShape: "sibling_ref",
      expectedResolvedValue: "string-or-object",
      accountIdPathSegmentIndex: 3,
    });
  });
});
