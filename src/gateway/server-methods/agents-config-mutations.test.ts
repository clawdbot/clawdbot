import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({ config: {} as OpenClawConfig }));

vi.mock("../../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js")),
  mutateConfigFileWithRetry: async <T>(params: {
    mutate: (draft: OpenClawConfig) => T | Promise<T>;
  }) => {
    const draft = structuredClone(mocks.config);
    const result = await params.mutate(draft);
    mocks.config = draft;
    return { nextConfig: draft, result };
  },
}));

const { deleteAgentConfigEntry } = await import("./agents-config-mutations.js");

describe("deleteAgentConfigEntry", () => {
  it("validates and reports the normalized roster match that it removes", async () => {
    mocks.config = {
      agents: {
        entries: {
          WORKER: { name: "Worker", workspace: "/tmp/worker" },
        },
      },
    };
    const validate = vi.fn();

    const committed = await deleteAgentConfigEntry({ agentId: "worker", validate });

    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "WORKER", name: "Worker", workspace: "/tmp/worker" }),
    );
    expect(committed.result).toMatchObject({ workspaceDir: "/tmp/worker" });
    expect(committed.nextConfig.agents?.entries).toBeUndefined();
  });
});
