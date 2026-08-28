import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerSandboxBackend } from "./backend.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./context.js";
import { isSandboxProvisioningError, toSandboxProvisioningError } from "./provisioning-error.js";

describe("sandbox provisioning errors", () => {
  it("preserves an existing typed error", () => {
    const error = toSandboxProvisioningError(new Error("missing image"), "docker");

    expect(toSandboxProvisioningError(error, "other")).toBe(error);
  });

  it("recognizes provisioning failures through wrapper causes", () => {
    const provisioningError = toSandboxProvisioningError(
      new Error("backend unavailable"),
      "docker",
    );
    const wrapped = new Error("agent setup failed", { cause: provisioningError });

    expect(isSandboxProvisioningError(wrapped)).toBe(true);
    expect(isSandboxProvisioningError(new Error("provider failed"))).toBe(false);
  });

  it("rejects required sessions without a creator before provisioning", async () => {
    await withOpenClawTestState({ label: "required-sandbox-missing-creator" }, async (state) => {
      const sessionKey = "agent:main:missing-creator";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "missing-creator-session", updatedAt: Date.now(), sandbox: "required" },
      );
      const backendFactory = vi.fn(async () => {
        throw new Error("A session without a creator must not provision a sandbox.");
      });
      const restore = registerSandboxBackend("missing-creator-backend", backendFactory);
      const config: OpenClawConfig = {
        session: { store: storePath },
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              backend: "missing-creator-backend",
              workspaceAccess: "rw",
            },
          },
          list: [{ id: "main" }],
        },
      };

      try {
        const params = { config, sessionKey, workspaceDir: state.workspaceDir };
        await expect(resolveSandboxContext(params)).rejects.toThrow(/creator|principal/i);
        await expect(ensureSandboxWorkspaceForSession(params)).rejects.toThrow(
          /creator|principal/i,
        );
        expect(backendFactory).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });
});
