import { afterEach, describe, expect, it } from "vitest";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { githubApiToken, hasConfiguredGitHubApiCredential } from "./control-ui-github-api.js";

afterEach(() => setActiveDegradedSecretOwners([]));

describe("Control UI GitHub credential", () => {
  it("keeps the explicit preview credential separate and preserves ambient fallback by omission", () => {
    const env = { GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" };

    expect(githubApiToken(env, {})).toBe("ambient-gh");
    expect(
      githubApiToken(env, {
        gateway: { controlUi: { github: { token: "preview-service-token" } } },
        tools: {
          github: {
            profileId: "ghp_99999999999999999999999999999999",
          },
        },
      }),
    ).toBe("preview-service-token");
    expect(() =>
      githubApiToken(env, {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_TOKEN" },
            },
          },
        },
      }),
    ).toThrow(SecretSurfaceUnavailableError);
  });

  it("fails closed for an explicitly configured cold SecretRef owner", () => {
    const config = {
      gateway: {
        controlUi: {
          github: {
            token: { source: "store" as const, provider: "default", id: "PREVIEW_TOKEN" },
          },
        },
      },
    };
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        degradationState: "cold",
        paths: ["gateway.controlUi.github.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);

    expect(() => githubApiToken({ GH_TOKEN: "ambient" }, config)).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(hasConfiguredGitHubApiCredential({}, config)).toBe(true);
    expect(githubApiToken({ GH_TOKEN: "ambient" }, {})).toBe("ambient");
  });
});
