import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const groupMocks = vi.hoisted(() => ({
  NotFound: class SessionGroupNotFoundError extends Error {},
  rename: vi.fn(),
  update: vi.fn(),
}));
const pathMocks = vi.hoisted(() => ({
  isCurrent: vi.fn(),
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
  isWorkspacePathContainmentCurrent: pathMocks.isCurrent,
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
    pathMocks.isCurrent.mockReset();
    pathMocks.isCurrent.mockReturnValue(true);
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
    const assertCurrent = vi.fn();
    const options = updateOptions(
      { name: "Client", cwd: "/workspace/link", worktree: true },
      respond,
      ["operator.write"],
    );
    options.sessionMutationAuthorization = {
      assertCurrent,
      assertTargetCurrent: vi.fn(),
    };
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(options);

    expect(assertCurrent).toHaveBeenCalledOnce();
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

  it("rejects containment retired by a runtime config change before commit", async () => {
    const containment = {
      path: "/workspace/client",
      workspaceRoot: "/workspace",
    };
    let finishContainment: ((value: typeof containment) => void) | undefined;
    pathMocks.resolveContainment.mockImplementation(
      async () =>
        await new Promise<typeof containment>((resolve) => {
          finishContainment = resolve;
        }),
    );
    const initialConfig = { agents: { defaults: { workspace: "/workspace" } } };
    const retiredConfig = { agents: { defaults: { workspace: "/replacement" } } };
    let runtimeConfig = initialConfig;
    pathMocks.isCurrent.mockImplementation((_containment, cfg) => cfg === initialConfig);
    const respond = vi.fn();
    const options = updateOptions(
      { name: "Client", cwd: "/workspace/client", worktree: true },
      respond,
      ["operator.write"],
    );
    options.context.getRuntimeConfig = () => runtimeConfig;
    const update = expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(options);

    await vi.waitFor(() => expect(pathMocks.resolveContainment).toHaveBeenCalledOnce());
    runtimeConfig = retiredConfig;
    finishContainment?.(containment);
    await update;

    expect(pathMocks.isCurrent).toHaveBeenCalledWith(containment, retiredConfig);
    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
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
