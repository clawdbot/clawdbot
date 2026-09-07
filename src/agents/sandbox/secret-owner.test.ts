import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { resolveSandboxContext } from "./context.js";
import { isSandboxProvisioningError } from "./provisioning-error.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("sandbox SSH secret owner", () => {
  it("classifies an unmaterialized inherited ref as terminal sandbox provisioning", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true } },
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            ssh: {
              target: "sandbox@example.com:22",
              identityData: {
                source: "env",
                provider: "default",
                id: "UNMATERIALIZED_SANDBOX_IDENTITY",
              },
            },
          },
        },
      },
    };

    const error = await resolveSandboxContext({
      config,
      agentId: "unlisted",
      sessionKey: "agent:unlisted:main",
    }).catch((caught: unknown) => caught);

    expect(isSandboxProvisioningError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "sandbox_provisioning",
      backendId: "ssh",
      message: expect.stringContaining("openclaw secrets reload"),
      cause: {
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "agent-sandbox:unlisted",
        paths: ["agents.defaults.sandbox.ssh.identityData"],
      },
    });
  });
});
