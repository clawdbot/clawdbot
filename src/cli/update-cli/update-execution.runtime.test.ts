import { expect, it, vi } from "vitest";

const configWriterLoaded = vi.hoisted(() => vi.fn());

vi.mock("../../config/io.write.js", () => {
  configWriterLoaded();
  return {};
});

vi.mock("./update-command-execution.js", () => ({ executeMutableUpdate: vi.fn() }));
vi.mock("./update-command-post-update.js", () => ({ finishUpdate: vi.fn() }));
vi.mock("./update-command-resume.js", () => ({ resumePostCoreUpdate: vi.fn() }));

it("loads the config writer before update execution can replace hashed chunks", async () => {
  expect(configWriterLoaded).not.toHaveBeenCalled();

  await import("./update-execution.runtime.js");

  expect(configWriterLoaded).toHaveBeenCalledOnce();
});
