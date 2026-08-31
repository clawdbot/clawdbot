import { describe, expect, it } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("execution auth binding fingerprints", () => {
  it("rejects an opaque CLI owner without an executable identity", () => {
    expect(
      fingerprintOpaqueRuntimeOwner({
        kind: "cli-runtime",
        runner: "cli",
        provider: "claude-cli",
        backendId: "claude-cli",
      }),
    ).toBeUndefined();
  });

  it("requires and binds an opaque plugin harness implementation", () => {
    const fingerprint = (runtimeArtifactFingerprint?: string) =>
      fingerprintOpaqueRuntimeOwner({
        kind: "plugin-harness",
        runner: "embedded",
        provider: "openai",
        backendId: "codex",
        ...(runtimeArtifactFingerprint ? { runtimeArtifactFingerprint } : {}),
      });

    expect(fingerprint()).toBeUndefined();
    expect(fingerprint("codex-runtime-v1")).not.toBe(fingerprint("codex-runtime-v2"));
  });

  it.each(["env", "file", "exec"] as const)(
    "rejects an unresolved %s static-secret reference",
    (source) => {
      expect(
        fingerprintAuthProfileCredential({
          profileId: "openai:bound",
          credential: {
            type: "api_key",
            provider: "openai",
            keyRef: { source, provider: "default", id: source === "env" ? "OPENAI_KEY" : "key" },
          },
        }),
      ).toBeUndefined();
    },
  );

  it("changes when a materialized static secret rotates", () => {
    const fingerprint = (key: string) =>
      fingerprintAuthProfileCredential({
        profileId: "openai:bound",
        credential: {
          type: "api_key",
          provider: "openai",
          key,
          keyRef: { source: "file", provider: "vault", id: "/openai/key" },
        },
      });

    expect(fingerprint("first-key")).not.toBe(fingerprint("replacement-key"));
  });

  it("binds a SecretRef profile to the resolved selected value", () => {
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      keyRef: { source: "env" as const, provider: "default", id: "OPENAI_KEY" },
    };
    const fingerprint = (apiKey: string, profileId = "openai:bound") =>
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:bound",
        credential,
        resolvedAuth: {
          apiKey,
          profileId,
          source: "profile:openai:bound",
          mode: "api-key",
        },
      });

    expect(fingerprint("first-key")).not.toBe(fingerprint("replacement-key"));
    expect(fingerprint("first-key", "openai:other")).toBeUndefined();
    expect(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:bound",
        credential,
        resolvedAuth: null,
      }),
    ).toBeUndefined();
  });

  it("keeps identity-bearing OAuth stable across token refreshes", () => {
    const fingerprint = (access: string, refresh: string) =>
      fingerprintAuthProfileCredential({
        profileId: "openai:oauth",
        credential: {
          type: "oauth",
          provider: "openai",
          access,
          refresh,
          expires: 1,
          accountId: "account-1",
          email: "User@Example.test",
        },
      });

    expect(fingerprint("access-a", "refresh-a")).toBe(fingerprint("access-b", "refresh-b"));
  });

  it("invalidates identity-less OAuth when its opaque grant changes", () => {
    const fingerprint = (access: string, refresh: string) =>
      fingerprintAuthProfileCredential({
        profileId: "anthropic:oauth",
        credential: {
          type: "oauth",
          provider: "anthropic",
          access,
          refresh,
          expires: 1,
        },
      });

    expect(fingerprint("access-a", "refresh-a")).not.toBe(fingerprint("access-b", "refresh-b"));
  });

  it("uses stable id-token identity instead of rotating token material", () => {
    const fingerprint = (access: string, subject: string) =>
      fingerprintAuthProfileCredential({
        profileId: "google:oauth",
        credential: {
          type: "oauth",
          provider: "google",
          access,
          refresh: `refresh-${access}`,
          expires: 1,
          idToken: jwt({ sub: subject, email: "user@example.test" }),
        },
      });

    expect(fingerprint("access-a", "subject-1")).toBe(fingerprint("access-b", "subject-1"));
    expect(fingerprint("access-a", "subject-1")).not.toBe(fingerprint("access-a", "subject-2"));
  });

  it("keeps resolved credential fingerprints opaque and stable within one process", () => {
    const fingerprint = (apiKey: string) =>
      fingerprintResolvedProviderAuth({
        apiKey,
        profileId: "openai:bound",
        source: "profile:openai:bound",
        mode: "api-key",
      });

    const secret = "raw-secret-marker-with-non-hex";
    const first = fingerprint(secret);

    expect(first).toBe(fingerprint(secret));
    expect(first).not.toBe(fingerprint("replacement-secret"));
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain(secret);
  });

  it("rejects auth modes without a concrete credential identity", () => {
    expect(
      fingerprintResolvedProviderAuth({ source: "aws-sdk:default-chain", mode: "aws-sdk" }),
    ).toBeUndefined();
  });

  it("keeps an opaque OAuth profile owner stable across runtime token refreshes", () => {
    const fingerprint = (access: string) =>
      fingerprintAuthProfileOwnerShape({
        profileId: "anthropic:cli",
        credential: {
          type: "oauth",
          provider: "anthropic",
          access,
          refresh: `refresh-${access}`,
          expires: 1,
          accountId: "account-1",
        },
      });

    expect(fingerprint("access-a")).toBe(fingerprint("access-b"));
    expect(
      fingerprintAuthProfileOwnerShape({
        profileId: "anthropic:missing",
        credential: undefined,
      }),
    ).toBeUndefined();
  });

  it("binds AWS SDK owners only to concrete bearer and static credentials", () => {
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    const fingerprint = (env: NodeJS.ProcessEnv) =>
      fingerprintAwsSdkRuntimeOwner({
        provider: "amazon-bedrock",
        backendId: "openclaw",
        auth,
        env,
      });

    expect(fingerprint({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" })).toBe(
      fingerprint({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" }),
    );
    expect(fingerprint({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" })).not.toBe(
      fingerprint({ AWS_BEARER_TOKEN_BEDROCK: "bearer-b" }),
    );
    expect(fingerprint({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "secret-a" })).not.toBe(
      fingerprint({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "secret-b" }),
    );
    expect(fingerprint({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "secret-a" })).not.toBe(
      fingerprint({ AWS_ACCESS_KEY_ID: "AKIA2", AWS_SECRET_ACCESS_KEY: "secret-a" }),
    );
    expect(
      fingerprint({
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "secret-a",
        AWS_SESSION_TOKEN: "session-a",
      }),
    ).not.toBe(
      fingerprint({
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "secret-a",
        AWS_SESSION_TOKEN: "session-b",
      }),
    );
  });

  it("fails closed when the AWS SDK principal cannot be established", () => {
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    const fingerprint = (env: NodeJS.ProcessEnv) =>
      fingerprintAwsSdkRuntimeOwner({
        provider: "amazon-bedrock",
        backendId: "openclaw",
        auth,
        env,
      });

    expect(fingerprint({ AWS_PROFILE: "work" })).toBeUndefined();
    expect(fingerprint({})).toBeUndefined();
    expect(
      fingerprint({
        AWS_PROFILE: "work",
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "secret-a",
      }),
    ).toBeUndefined();
  });
});
