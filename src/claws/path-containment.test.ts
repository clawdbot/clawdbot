import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { clawContainedRelativePath } from "./path-containment.js";

describe("clawContainedRelativePath", () => {
  const root = resolve(sep, "claw-root");

  it("returns native relative paths only for strict descendants", () => {
    expect(clawContainedRelativePath(root, root)).toBeUndefined();
    expect(clawContainedRelativePath(root, join(root, "file.md"))).toBe("file.md");
    expect(clawContainedRelativePath(root, join(root, "nested", "file.md"))).toBe(
      join("nested", "file.md"),
    );
  });

  it.each([
    ["parent", join(root, "..", "outside.md")],
    ["prefix sibling", join(`${root}-sibling`, "file.md")],
    ["unrelated absolute root", resolve(sep, "unrelated", "file.md")],
  ])("rejects %s paths", (_name, target) => {
    expect(clawContainedRelativePath(root, target)).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("rejects cross-drive and cross-UNC paths", () => {
    expect(clawContainedRelativePath("C:\\root", "D:\\root\\file.md")).toBeUndefined();
    expect(
      clawContainedRelativePath("\\\\server\\share\\root", "\\\\other\\share\\root\\file.md"),
    ).toBeUndefined();
  });
});
