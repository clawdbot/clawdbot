import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.fn();
const syncMatrixOwnProfileMock = vi.fn();
const withResolvedActionClientMock = vi.fn();

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    media: {
      loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
    },
  }),
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: (...args: unknown[]) => syncMatrixOwnProfileMock(...args),
}));

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
}));

const { updateMatrixOwnProfile } = await import("./profile.js");

function mockCallAt(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  index: number,
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstMockArg(mock: { mock: { calls: Array<readonly unknown[]> } }, label: string) {
  return mockCallAt(mock, 0, label)[0];
}

describe("matrix profile actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("avatar"),
      contentType: "image/png",
      fileName: "avatar.png",
    });
    syncMatrixOwnProfileMock.mockResolvedValue({
      skipped: false,
      displayNameUpdated: true,
      avatarUpdated: true,
      resolvedAvatarUrl: "mxc://example/avatar",
      convertedAvatarFromHttp: true,
      uploadedAvatarSource: "http",
    });
  });

  it("trims profile fields and persists through the action client wrapper", async () => {
    const actionClient = {
      getUserId: vi.fn(async () => "@bot:example.org"),
    };
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run(actionClient);
    });

    await updateMatrixOwnProfile({
      accountId: "ops",
      displayName: "  Ops Bot  ",
      avatarUrl: "  mxc://example/avatar  ",
      avatarPath: "  /tmp/avatar.png  ",
    });

    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    const [wrapperOpts, run, mode] = mockCallAt(
      withResolvedActionClientMock,
      0,
      "Matrix action client wrapper",
    );
    expect(wrapperOpts).toEqual({
      accountId: "ops",
      displayName: "  Ops Bot  ",
      avatarUrl: "  mxc://example/avatar  ",
      avatarPath: "  /tmp/avatar.png  ",
    });
    expect(typeof run).toBe("function");
    expect(mode).toBe("persist");

    expect(syncMatrixOwnProfileMock).toHaveBeenCalledTimes(1);
    const syncCall = firstMockArg(syncMatrixOwnProfileMock, "Matrix profile sync") as
      | {
          client: unknown;
          userId: string;
          displayName: string;
          avatarUrl: string;
          avatarPath: string;
          loadAvatarFromUrl: unknown;
          loadAvatarFromPath: unknown;
        }
      | undefined;
    if (!syncCall) {
      throw new Error("syncMatrixOwnProfile was not called");
    }
    const { client, loadAvatarFromUrl, loadAvatarFromPath, ...profileFields } = syncCall;
    expect(client).toBe(actionClient);
    expect(typeof loadAvatarFromUrl).toBe("function");
    expect(typeof loadAvatarFromPath).toBe("function");
    expect(profileFields).toEqual({
      userId: "@bot:example.org",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      avatarPath: "/tmp/avatar.png",
    });
  });

  it("bridges avatar loaders through Matrix runtime media helpers", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        getUserId: vi.fn(async () => "@bot:example.org"),
      });
    });

    await updateMatrixOwnProfile({
      avatarUrl: "https://cdn.example.org/avatar.png",
      avatarPath: "/tmp/avatar.png",
    });

    const call = firstMockArg(syncMatrixOwnProfileMock, "Matrix profile sync") as
      | {
          loadAvatarFromUrl: (url: string, maxBytes: number) => Promise<unknown>;
          loadAvatarFromPath: (path: string, maxBytes: number) => Promise<unknown>;
        }
      | undefined;

    if (!call) {
      throw new Error("syncMatrixOwnProfile was not called");
    }

    await call.loadAvatarFromUrl("https://cdn.example.org/avatar.png", 123);
    await call.loadAvatarFromPath("/tmp/avatar.png", 456);

    expect(loadWebMediaMock).toHaveBeenNthCalledWith(1, "https://cdn.example.org/avatar.png", 123);
    expect(loadWebMediaMock).toHaveBeenNthCalledWith(2, "/tmp/avatar.png", {
      maxBytes: 456,
      localRoots: undefined,
    });
  });
});
