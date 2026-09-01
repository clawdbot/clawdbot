import { describe, expect, it, vi } from "vitest";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  readCodexManagedRequirementsFingerprint,
} from "./thread-requests.js";

const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};

describe("configured app-server managed requirements", () => {
  it("admits managed hooks for an interactive plugin-policy turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("admits the exact managed requirements captured for a scheduled restricted turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const managedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request,
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint: managedRequirementsFingerprint,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when managed requirements change after scheduled authorization", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const allowedManagedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request: vi.fn(async () => ({ requirements: { hooks: {} } })),
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint,
      }),
    ).rejects.toThrow("managed requirements changed");
  });
});
