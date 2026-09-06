import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({
  readCanonicalCommand: vi.fn(),
  readGatewayServiceCommandForMutation: vi.fn(),
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ readCommand: mocks.readCanonicalCommand }),
  readGatewayServiceCommandForMutation: mocks.readGatewayServiceCommandForMutation,
}));

vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));

import {
  gatewayServiceCommandUsesRoot,
  resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

describe("update service mutation reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCanonicalCommand.mockResolvedValue(null);
  });

  it("uses a relocated definition for node, package-root, and ownership decisions", async () => {
    await withTempDir("openclaw-update-relocated-service-", async (root) => {
      const currentRoot = path.join(root, "current");
      const relocatedRoot = path.join(root, "relocated");
      const nodeRunner = path.join(root, "service-bin", "node");
      const entrypoint = path.join(relocatedRoot, "dist", "index.js");
      await fs.mkdir(path.dirname(entrypoint), { recursive: true });
      await fs.writeFile(
        path.join(relocatedRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.2.3" }),
      );
      await fs.writeFile(entrypoint, "export {};\n");
      const relocatedRootReal = await fs.realpath(relocatedRoot);
      const command = {
        programArguments: [nodeRunner, entrypoint, "gateway", "--port", "18789"],
      };
      mocks.readGatewayServiceCommandForMutation.mockResolvedValue({
        kind: "relocated",
        plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
        command,
      });

      await expect(resolveManagedServicePackageUpdatePlan({ root: currentRoot })).resolves.toEqual({
        rootRedirect: {
          root: relocatedRootReal,
          previousRoot: currentRoot,
        },
        nodeRunner,
      });
      await expect(gatewayServiceCommandUsesRoot({ root: relocatedRoot })).resolves.toBe(true);

      expect(mocks.readGatewayServiceCommandForMutation).toHaveBeenCalledTimes(2);
      expect(mocks.readCanonicalCommand).not.toHaveBeenCalled();
    });
  });
});
