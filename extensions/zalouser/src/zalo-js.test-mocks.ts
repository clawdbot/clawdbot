import { vi, type Mock } from "vitest";

type ZaloJsModule = typeof import("./zalo-js.js");
type ZaloJsMocks = {
  checkZaloAuthenticatedMock: Mock<ZaloJsModule["checkZaloAuthenticated"]>;
  getZaloUserInfoMock: Mock<ZaloJsModule["getZaloUserInfo"]>;
  listZaloFriendsMock: Mock<ZaloJsModule["listZaloFriends"]>;
  listZaloFriendsMatchingMock: Mock<ZaloJsModule["listZaloFriendsMatching"]>;
  listZaloGroupMembersMock: Mock<ZaloJsModule["listZaloGroupMembers"]>;
  listZaloGroupsMock: Mock<ZaloJsModule["listZaloGroups"]>;
  listZaloGroupsMatchingMock: Mock<ZaloJsModule["listZaloGroupsMatching"]>;
  logoutZaloProfileMock: Mock<ZaloJsModule["logoutZaloProfile"]>;
  resolveZaloAllowFromEntriesMock: Mock<ZaloJsModule["resolveZaloAllowFromEntries"]>;
  resolveZaloGroupContextMock: Mock<ZaloJsModule["resolveZaloGroupContext"]>;
  resolveZaloGroupsByEntriesMock: Mock<ZaloJsModule["resolveZaloGroupsByEntries"]>;
  startZaloListenerMock: Mock<ZaloJsModule["startZaloListener"]>;
  startZaloQrLoginMock: Mock<ZaloJsModule["startZaloQrLogin"]>;
  waitForZaloQrLoginMock: Mock<ZaloJsModule["waitForZaloQrLogin"]>;
};

const zaloJsMocks = vi.hoisted(
  (): ZaloJsMocks => ({
    checkZaloAuthenticatedMock: vi.fn(async () => false),
    getZaloUserInfoMock: vi.fn(async () => null),
    listZaloFriendsMock: vi.fn(async () => []),
    listZaloFriendsMatchingMock: vi.fn(async () => []),
    listZaloGroupMembersMock: vi.fn(async () => []),
    listZaloGroupsMock: vi.fn(async () => []),
    listZaloGroupsMatchingMock: vi.fn(async () => []),
    logoutZaloProfileMock: vi.fn(async () => ({
      cleared: true,
      loggedOut: true,
      message: "Logged out and cleared local session.",
    })),
    resolveZaloAllowFromEntriesMock: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
    resolveZaloGroupContextMock: vi.fn(async (_profile, groupId) => ({
      groupId,
      name: undefined,
      members: [],
    })),
    resolveZaloGroupsByEntriesMock: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
    startZaloListenerMock: vi.fn(async () => ({ stop: vi.fn() })),
    startZaloQrLoginMock: vi.fn(async () => ({
      message: "qr pending",
      qrDataUrl: undefined,
    })),
    waitForZaloQrLoginMock: vi.fn(async () => ({
      connected: false,
      message: "login pending",
    })),
  }),
);

export const checkZaloAuthenticatedMock = zaloJsMocks.checkZaloAuthenticatedMock;
export const getZaloUserInfoMock = zaloJsMocks.getZaloUserInfoMock;
export const listZaloFriendsMock = zaloJsMocks.listZaloFriendsMock;
export const listZaloFriendsMatchingMock = zaloJsMocks.listZaloFriendsMatchingMock;
export const listZaloGroupMembersMock = zaloJsMocks.listZaloGroupMembersMock;
export const listZaloGroupsMock = zaloJsMocks.listZaloGroupsMock;
export const listZaloGroupsMatchingMock = zaloJsMocks.listZaloGroupsMatchingMock;
export const logoutZaloProfileMock = zaloJsMocks.logoutZaloProfileMock;
export const resolveZaloAllowFromEntriesMock = zaloJsMocks.resolveZaloAllowFromEntriesMock;
export const resolveZaloGroupContextMock = zaloJsMocks.resolveZaloGroupContextMock;
export const resolveZaloGroupsByEntriesMock = zaloJsMocks.resolveZaloGroupsByEntriesMock;
export const startZaloListenerMock: Mock<ZaloJsModule["startZaloListener"]> =
  zaloJsMocks.startZaloListenerMock;
export const startZaloQrLoginMock = zaloJsMocks.startZaloQrLoginMock;
export const waitForZaloQrLoginMock = zaloJsMocks.waitForZaloQrLoginMock;

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: checkZaloAuthenticatedMock,
  getZaloUserInfo: getZaloUserInfoMock,
  listZaloFriends: listZaloFriendsMock,
  listZaloFriendsMatching: listZaloFriendsMatchingMock,
  listZaloGroupMembers: listZaloGroupMembersMock,
  listZaloGroups: listZaloGroupsMock,
  listZaloGroupsMatching: listZaloGroupsMatchingMock,
  logoutZaloProfile: logoutZaloProfileMock,
  resolveZaloAllowFromEntries: resolveZaloAllowFromEntriesMock,
  resolveZaloGroupContext: resolveZaloGroupContextMock,
  resolveZaloGroupsByEntries: resolveZaloGroupsByEntriesMock,
  startZaloListener: startZaloListenerMock,
  startZaloQrLogin: startZaloQrLoginMock,
  waitForZaloQrLogin: waitForZaloQrLoginMock,
}));
