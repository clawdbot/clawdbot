import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";

type DiscordWebMediaMockFactoryResult = {
  loadWebMedia: MockFn;
  loadWebMediaRaw: MockFn;
};

type DiscordRestFactoryResult = {
  rest: import("@buape/carbon").RequestClient;
  postMock: MockFn;
  putMock: MockFn;
  getMock: MockFn;
  patchMock: MockFn;
  deleteMock: MockFn;
};

export function discordWebMediaMockFactory(): DiscordWebMediaMockFactoryResult {
  return {
    loadWebMedia: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      kind: "image",
    }),
    loadWebMediaRaw: vi.fn().mockResolvedValue({
      buffer: Buffer.from("img"),
      fileName: "asset.png",
      contentType: "image/png",
      kind: "image",
    }),
  };
}

export function makeDiscordRest(): DiscordRestFactoryResult {
  const postMock = vi.fn() as unknown as MockFn;
  const putMock = vi.fn() as unknown as MockFn;
  const getMock = vi.fn() as unknown as MockFn;
  const patchMock = vi.fn() as unknown as MockFn;
  const deleteMock = vi.fn() as unknown as MockFn;

  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as import("@buape/carbon").RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
}
