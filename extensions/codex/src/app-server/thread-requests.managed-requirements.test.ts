import { describe, expect, it, vi } from "vitest";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  buildCodexManagedRequirementsFingerprint,
} from "./thread-requests.js";

const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};

describe("configured app-server managed requirements", () => {
  it("admits the exact managed requirements captured for a scheduled restricted turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint:
          buildCodexManagedRequirementsFingerprint(managedRequirements),
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when managed requirements change after scheduled authorization", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint: buildCodexManagedRequirementsFingerprint({
          hooks: {},
        }),
      }),
    ).rejects.toThrow("managed requirements changed");
  });
});
