import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeExecutable,
  makeExecApprovalsTempDir,
} from "../../infra/exec-approvals-test-helpers.js";
import { loadExecApprovals, saveExecApprovals } from "../../infra/exec-approvals.js";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.unstubAllEnvs();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
});

describe("native Bash execution policy", () => {
  it.each([
    ["allowlist", "on-miss", "allow"],
    ["deny", "on-miss", "deny"],
    ["allowlist", "off", "deny"],
  ] as const)(
    "applies %s/%s to native Bash with configured PATH",
    async (security, ask, behavior) => {
      const dir = makeExecApprovalsTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const binary = makeExecutable(dir, "gog");
      saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
      const { context } = await createExecution({
        config: { tools: { exec: { security, ask, pathPrepend: [dir] } } },
        nativeTools: ["Bash"],
      });
      let decision: CliBackendToolPermissionResult | undefined;
      await runPlugin(context, async function* (execution) {
        decision = await execution.requestToolPermission({
          toolName: "Bash",
          toolInput: { command: "gog calendar list" },
          cwd: dir,
        });
        yield SUCCESS_RESULT;
      });
      expect(decision?.behavior).toBe(behavior);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      if (decision?.behavior === "allow") {
        expect(decision.updatedInput?.command).toContain(binary);
        expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toEqual(
          expect.any(Number),
        );
      } else {
        expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
      }
    },
  );
});
