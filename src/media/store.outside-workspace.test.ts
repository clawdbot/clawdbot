// Outside-workspace store tests cover media storage outside project roots.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const mocks = vi.hoisted(() => ({
  readLocalFileSafely: vi.fn(),
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  readLocalFileSafely: mocks.readLocalFileSafely,
}));

type StoreModule = typeof import("./store.js");

let saveMediaSource: StoreModule["saveMediaSource"];

async function expectOutsideWorkspaceStoreFailure(sourcePath: string, sourceError: Error) {
  let storeError: unknown;
  try {
    await saveMediaSource(sourcePath);
  } catch (error) {
    storeError = error;
  }
  // SaveMediaSourceError is module-private; assert its stable structural contract.
  expect(storeError).toBeInstanceOf(Error);
  const err = storeError as Error & { code?: string };
  expect(err.name).toBe("SaveMediaSourceError");
  expect(err.code).toBe("invalid-path");
  expect(err.message).toBe("Media path is outside workspace root");
  expect(err.cause).toBe(sourceError);
  expect(err.cause).toMatchObject({
    code: "outside-workspace",
    message: "file is outside workspace root",
  });
}

describe("media store outside-workspace mapping", () => {
  let tempHome: TempHomeEnv;
  let home = "";

  beforeAll(async () => {
    vi.resetModules();
    ({ saveMediaSource } = await import("./store.js"));
    tempHome = await createTempHomeEnv("openclaw-media-store-test-home-");
    home = tempHome.home;
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } finally {
      vi.doUnmock("../infra/fs-safe.js");
      vi.resetModules();
    }
  });

  it("maps outside-workspace reads to a descriptive invalid-path error", async () => {
    const sourcePath = path.join(home, "outside-media.txt");
    await fs.writeFile(sourcePath, "hello");
    const { FsSafeError } = await import("../infra/fs-safe.js");
    const sourceError = new FsSafeError("outside-workspace", "file is outside workspace root");
    mocks.readLocalFileSafely.mockRejectedValueOnce(sourceError);

    await expectOutsideWorkspaceStoreFailure(sourcePath, sourceError);
  });
});
