import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { resolveSandboxContext } from "./context.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("sandbox SSH secret owner", () => {
  it("rejects an unmaterialized inherited ref without active degraded-owner state", async () => {
    const config: OpenClawConfig = {
      agents: {
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

    await expect(
      resolveSandboxContext({
        config,
        agentId: "unlisted",
        sessionKey: "agent:unlisted:main",
      }),
    ).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId: "agent-sandbox:unlisted",
      paths: ["agents.defaults.sandbox.ssh.identityData"],
    });
  });
});
