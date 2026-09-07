import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import "../../agents/test-helpers/fast-openclaw-tools.js";
import { prepareRootedExecutionCapability } from "../../agents/rooted-run-params.js";
import { createAgentToolsSandboxContext } from "../../agents/test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../mcp-http.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const callGatewayTool = vi.hoisted(() =>
  vi.fn(async () => ({ id: "review-approval", decision: null })),
);
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool }));

describe("rooted CLI mediated tools", () => {
  beforeEach(() => {
    callGatewayTool.mockClear();
  });
  it("enforces the host root and exact file-tool cap through MCP projection", async () => {
    const parent = tempDirs.make("openclaw-rooted-mcp-");
    const root = path.join(parent, "workshop");
    const cfg = { plugins: { enabled: false }, tools: { fs: { workspaceOnly: false } } };
    const rootedExecution = await prepareRootedExecutionCapability({
      rootedExecution: { root },
      config: cfg,
      sessionId: "review",
      sessionKey: "agent:main:cron:review",
    });
    const scope = {
      cfg,
      rootedExecution,
      context: {
        sessionKey: "agent:main:cron:review",
        workspaceDir: parent,
        senderIsOwner: false,
        toolsAllow: ["read", "write"],
      },
    };
    const projected = await resolveMcpLoopbackPolicyTools(scope);
    expect(projected.tools.map((tool) => tool.name).toSorted()).toEqual([
      "apply_patch",
      "read",
      "write",
    ]);
    const granted = await resolveMcpLoopbackScopedTools(scope);
    expect(granted.tools.map((tool) => tool.name).toSorted()).toEqual(["read", "write"]);
    const write = granted.tools.find((tool) => tool.name === "write")!;
    const read = granted.tools.find((tool) => tool.name === "read")!;
    await write.execute("report", { path: "report.md", content: "Review complete" });
    await expect(fs.readFile(path.join(root, "report.md"), "utf8")).resolves.toBe(
      "Review complete",
    );
    await expect(
      write.execute("outside", { path: path.join(parent, "outside.md"), content: "denied" }),
    ).rejects.toThrow(/outside|escapes/i);
    await fs.writeFile(path.join(parent, "private.md"), "not review material");
    await expect(
      read.execute("outside-read", { path: path.join(parent, "private.md") }),
    ).rejects.toThrow(/outside|escapes/i);
    expect(
      (
        await resolveMcpLoopbackScopedTools({
          ...scope,
          context: { ...scope.context, toolsAllow: [] },
        })
      ).tools,
    ).toEqual([]);
  });

  it("edits the Workshop through the sandbox retained by the MCP grant", async () => {
    const root = tempDirs.make("openclaw-rooted-mcp-sandbox-");
    await fs.writeFile(path.join(root, "SKILL.md"), "Original guidance\n");
    const bridge = createHostSandboxFsBridge(root);
    const writeFile = vi.spyOn(bridge, "writeFile");
    const scope = await resolveMcpLoopbackScopedTools({
      cfg: { plugins: { enabled: false } },
      rootedExecution: {
        root,
        workspaceDir: root,
        cwd: root,
        requireWorkspaceOnly: true,
        sandbox: createAgentToolsSandboxContext({ workspaceDir: root, fsBridge: bridge }),
      },
      context: { sessionKey: "agent:main:cron:review", senderIsOwner: false, toolsAllow: ["edit"] },
    });
    const edit = scope.tools.find((tool) => tool.name === "edit")!;
    await edit.execute("review-edit", {
      path: "SKILL.md",
      edits: [{ oldText: "Original", newText: "Reviewed" }],
    });
    expect(writeFile).toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "SKILL.md"), "utf8")).resolves.toBe(
      "Reviewed guidance\n",
    );
  });

  it.each(
    [false, true].flatMap((rooted) => [
      { rooted, security: "deny" as const, ask: "off" as const },
      { rooted, security: "allowlist" as const, ask: "always" as const },
    ]),
  )(
    "keeps cron exec policy $security/$ask with rooted execution $rooted",
    async ({ rooted, security, ask }) => {
      const root = tempDirs.make("openclaw-rooted-exec-policy-");
      const cfg = {
        plugins: { enabled: false },
        tools: {
          exec: { host: "gateway" as const, security, ask },
        },
      };
      const rootedExecution = rooted
        ? await prepareRootedExecutionCapability({
            rootedExecution: { root },
            config: cfg,
            sessionId: "review",
            sessionKey: "agent:main:cron:review",
          })
        : undefined;
      const scope = await resolveMcpLoopbackScopedTools({
        cfg,
        rootedExecution,
        context: {
          sessionKey: "agent:main:cron:review",
          workspaceDir: root,
          senderIsOwner: false,
          trigger: "cron",
          toolsAllow: ["exec"],
        },
      });
      const exec = scope.tools.find((tool) => tool.name === "exec")!;
      await expect(exec.execute("denied-command", { command: "printf review" })).rejects.toThrow(
        /denied|security=deny/,
      );
      if (ask === "always") {
        expect(callGatewayTool).toHaveBeenCalledWith(
          "exec.approval.request",
          expect.anything(),
          expect.objectContaining({ security, ask, deliverToApprovalClientsOnly: true }),
          expect.anything(),
        );
      } else {
        expect(callGatewayTool).not.toHaveBeenCalled();
      }
    },
  );
});
