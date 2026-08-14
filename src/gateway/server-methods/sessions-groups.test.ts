import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const groupMocks = vi.hoisted(() => ({
  NotFound: class SessionGroupNotFoundError extends Error {},
  rename: vi.fn(),
  update: vi.fn(),
}));
const pathMocks = vi.hoisted(() => ({
  resolveContainment: vi.fn(),
}));

vi.mock("../session-groups.js", () => ({
  deleteSessionGroup: vi.fn(),
  listSessionGroupDefaults: vi.fn(() => []),
  listSessionGroups: vi.fn(() => []),
  listSidebarSectionOrder: vi.fn(() => []),
  putSessionGroups: vi.fn(() => []),
  renameSessionGroup: groupMocks.rename,
  SessionGroupNotFoundError: groupMocks.NotFound,
  updateSessionGroupDefaults: groupMocks.update,
}));
vi.mock("./workspace-path-containment.js", () => ({
  resolveWorkspacePathContainment: pathMocks.resolveContainment,
}));

import { sessionGroupHandlers } from "./sessions-groups.js";

function updateOptions(
  params: Record<string, unknown>,
  respond: ReturnType<typeof vi.fn>,
  scopes = ["operator.write", "operator.admin"],
) {
  return {
    params,
    respond,
    client: { connect: { scopes } },
    context: {
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function renameOptions(params: Record<string, unknown>, respond: ReturnType<typeof vi.fn>) {
  return {
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("sessions.groups.update", () => {
  beforeEach(() => {
    groupMocks.update.mockReset();
    pathMocks.resolveContainment.mockReset();
  });

  it("rejects a relative cwd before mutating defaults", async () => {
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(updateOptions({ name: "Travel", cwd: "tmp/travel", worktree: false }, respond));

    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects a stale target without recreating it", async () => {
    groupMocks.update.mockReturnValue(null);
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(updateOptions({ name: "Travel", cwd: "/tmp/travel", worktree: true }, respond));

    expect(groupMocks.update).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown session group: Travel",
      }),
    );
  });

  it("rejects a non-admin cwd outside configured workspaces", async () => {
    pathMocks.resolveContainment.mockResolvedValue(null);
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(
      updateOptions({ name: "Travel", cwd: "/outside/travel", worktree: false }, respond, [
        "operator.write",
      ]),
    );

    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
  });

  it("persists the canonical workspace-contained cwd for a write caller", async () => {
    pathMocks.resolveContainment.mockResolvedValue({
      path: "/workspace/client",
      workspaceRoot: "/workspace",
    });
    groupMocks.update.mockReturnValue([
      { name: "Client", cwd: "/workspace/client", worktree: true },
    ]);
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(
      updateOptions({ name: "Client", cwd: "/workspace/link", worktree: true }, respond, [
        "operator.write",
      ]),
    );

    expect(groupMocks.update).toHaveBeenCalledWith("Client", {
      cwd: "/workspace/client",
      worktree: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        defaults: [{ name: "Client", cwd: "/workspace/client", worktree: true }],
      },
      undefined,
    );
  });
});

describe("sessions.groups.rename", () => {
  beforeEach(() => {
    groupMocks.rename.mockReset();
  });

  it("rejects an unknown source group", async () => {
    groupMocks.rename.mockRejectedValue(new groupMocks.NotFound("unknown session group: Missing"));
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.rename"],
      'sessionGroupHandlers["sessions.groups.rename"] test invariant',
    )(renameOptions({ name: "Missing", to: "Other" }, respond));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown session group: Missing",
      }),
    );
  });
});
