import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayInteractiveSurfaceAuth,
  resolveGatewayProbeSurfaceAuth,
} from "./auth-surface-resolution.js";

const ambientAuth = {
  OPENCLAW_GATEWAY_TOKEN: "ambient-token",
  OPENCLAW_GATEWAY_PASSWORD: "ambient-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;

function missingSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function configWithSecretProvider(gateway: NonNullable<OpenClawConfig["gateway"]>): OpenClawConfig {
  return {
    gateway,
    secrets: { providers: { default: { source: "env" } } },
  };
}

const unavailableGatewayRefCases = [
  {
    label: "local token mode",
    surface: "local",
    gateway: {
      auth: { mode: "token", token: missingSecretRef("MISSING_LOCAL_TOKEN") },
    },
    path: "gateway.auth.token",
  },
  {
    label: "implicit local token mode",
    surface: "local",
    gateway: { auth: { token: missingSecretRef("MISSING_LOCAL_TOKEN") } },
    path: "gateway.auth.token",
  },
  {
    label: "local password mode",
    surface: "local",
    gateway: {
      auth: { mode: "password", password: missingSecretRef("MISSING_LOCAL_PASSWORD") },
    },
    path: "gateway.auth.password",
  },
  {
    label: "implicit local password mode",
    surface: "local",
    gateway: { auth: { password: missingSecretRef("MISSING_LOCAL_PASSWORD") } },
    path: "gateway.auth.password",
  },
  {
    label: "remote token",
    surface: "remote",
    gateway: { remote: { token: missingSecretRef("MISSING_REMOTE_TOKEN") } },
    path: "gateway.remote.token",
  },
  {
    label: "remote password",
    surface: "remote",
    gateway: { remote: { password: missingSecretRef("MISSING_REMOTE_PASSWORD") } },
    path: "gateway.remote.password",
  },
] as const;

describe("Gateway auth surface resolution", () => {
  it.each(unavailableGatewayRefCases)(
    "keeps unavailable $label refs authoritative across probe and interactive surfaces",
    async (testCase) => {
      const params = {
        config: configWithSecretProvider(testCase.gateway),
        env: ambientAuth,
        surface: testCase.surface,
      };
      const [probe, interactive] = await Promise.all([
        resolveGatewayProbeSurfaceAuth(params),
        resolveGatewayInteractiveSurfaceAuth(params),
      ]);

      expect(probe.token).toBeUndefined();
      expect(probe.password).toBeUndefined();
      expect(probe.source).toBeUndefined();
      expect(probe.diagnostics).toEqual([
        expect.stringContaining(`${testCase.path} SecretRef is unresolved`),
      ]);
      expect(interactive.token).toBeUndefined();
      expect(interactive.password).toBeUndefined();
      expect(interactive.failureReason).toContain(`${testCase.path} SecretRef is unresolved`);
    },
  );

  it("preserves a healthy configured remote password when its sibling token ref fails", async () => {
    const params = {
      config: configWithSecretProvider({
        remote: {
          token: missingSecretRef("MISSING_REMOTE_TOKEN"),
          password: "configured-password", // pragma: allowlist secret
        },
      }),
      env: ambientAuth,
      surface: "remote" as const,
    };
    const [probe, interactive] = await Promise.all([
      resolveGatewayProbeSurfaceAuth(params),
      resolveGatewayInteractiveSurfaceAuth(params),
    ]);

    expect(probe).toEqual({
      token: undefined,
      password: "configured-password", // pragma: allowlist secret
      source: "config",
      diagnostics: [expect.stringContaining("gateway.remote.token SecretRef is unresolved")],
    });
    expect(interactive).toEqual({
      token: undefined,
      password: "configured-password", // pragma: allowlist secret
    });
  });

  it.each([
    { mode: "password", inactiveCredential: "token" },
    { mode: "token", inactiveCredential: "password" },
  ] as const)(
    "ignores an unavailable $inactiveCredential ref when explicit $mode mode selects its sibling",
    async ({ mode, inactiveCredential }) => {
      await expect(
        resolveGatewayProbeSurfaceAuth({
          config: configWithSecretProvider({
            auth: {
              mode,
              [mode]: `configured-${mode}`,
              [inactiveCredential]: missingSecretRef("MISSING_INACTIVE_CREDENTIAL"),
            },
          }),
          env: ambientAuth,
          surface: "local",
        }),
      ).resolves.toEqual({ [mode]: `configured-${mode}`, source: "config" });
    },
  );

  it.each([
    {
      label: "remote token",
      surface: "remote",
      gateway: { remote: { token: missingSecretRef("MISSING_REMOTE_TOKEN") } },
      explicitAuth: { token: "explicit-token" },
      expected: { token: "explicit-token", password: undefined },
    },
    {
      label: "local password overriding token mode",
      surface: "local",
      gateway: {
        auth: { mode: "token", token: missingSecretRef("MISSING_LOCAL_TOKEN") },
      },
      explicitAuth: { password: "explicit-password" }, // pragma: allowlist secret
      expected: { token: undefined, password: "explicit-password" }, // pragma: allowlist secret
    },
  ] as const)(
    "keeps explicit $label authoritative over unavailable configured refs",
    async (testCase) => {
      await expect(
        resolveGatewayInteractiveSurfaceAuth({
          config: configWithSecretProvider(testCase.gateway),
          env: ambientAuth,
          explicitAuth: testCase.explicitAuth,
          surface: testCase.surface,
        }),
      ).resolves.toEqual(testCase.expected);
    },
  );

  it("keeps a resolved remote password ref ahead of ambient password", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: configWithSecretProvider({
          remote: { password: missingSecretRef("REMOTE_PASSWORD") },
        }),
        env: { ...ambientAuth, REMOTE_PASSWORD: "resolved-remote-password" },
        surface: "remote",
      }),
    ).resolves.toEqual({ token: undefined, password: "resolved-remote-password" }); // pragma: allowlist secret
  });
});
