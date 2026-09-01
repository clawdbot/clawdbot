import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createWorktreesHandlers } from "./worktrees.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function worktreeRecord(repoRoot: string): ManagedWorktreeRecord {
  return {
    id: "worktree-id",
    name: "task-one",
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: "/state/worktrees/0123456789abcdef/task-one",
    branch: "openclaw/task-one",
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 2,
  };
}

async function dispatchCreate(params: { repoRoot: string; scopes: string[]; workspace: string }) {
  const create = vi.fn(async () => worktreeRecord(params.repoRoot));
  const handler = createWorktreesHandlers({ create } as never)["worktrees.create"];
  if (!handler) {
    throw new Error("worktrees.create handler is not registered");
  }
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "req-worktree-create",
      method: "worktrees.create",
      params: { repoRoot: params.repoRoot },
    },
    respond,
    client: {
      connId: "conn-worktree-create",
      connect: {
        role: "operator",
        scopes: params.scopes,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true, workspace: params.workspace }] },
      }),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    extraHandlers: { "worktrees.create": handler },
  });
  return { create, respond };
}

describe("worktrees.create authorization", () => {
  it("allows write-scoped creation inside an agent workspace", async () => {
    const workspace = await fs.realpath(tempDirs.make("openclaw-worktree-create-auth-"));
    const repoRoot = path.join(workspace, "project");
    await fs.mkdir(repoRoot);

    const { create, respond } = await dispatchCreate({
      repoRoot,
      scopes: ["operator.write"],
      workspace,
    });

    expect(create).toHaveBeenCalledWith({
      repoRoot,
      name: undefined,
      baseRef: undefined,
      ownerKind: "manual",
      runSetupScript: false,
    });
    expect(respond).toHaveBeenCalledWith(true, worktreeRecord(repoRoot), undefined);
  });

  it("keeps arbitrary host paths admin-only", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-worktree-create-host-auth-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await Promise.all([fs.mkdir(workspace), fs.mkdir(outside)]);

    const write = await dispatchCreate({
      repoRoot: outside,
      scopes: ["operator.write"],
      workspace,
    });
    expect(write.create).not.toHaveBeenCalled();
    expect(write.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const admin = await dispatchCreate({
      repoRoot: outside,
      scopes: ["operator.admin"],
      workspace,
    });
    expect(admin.create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: outside, runSetupScript: true }),
    );
    expect(admin.respond).toHaveBeenCalledWith(true, worktreeRecord(outside), undefined);
  });
});
