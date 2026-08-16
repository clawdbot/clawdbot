import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const scanPackageInstallSourceMock = vi.fn();
const scanInstalledPackageDependencyTreeMock = vi.fn();

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanPackageInstallSourceMock(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) =>
    scanInstalledPackageDependencyTreeMock(...args),
}));

const { installHooksFromPath } = await import("./install.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("hook install policy warnings", () => {
  it("passes acknowledgement through both scan stages", async () => {
    const root = tempDirs.make("openclaw-hook-policy-");
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "HOOK.md"), "---\nname: my-hook\n---\n");
    fs.writeFileSync(path.join(source, "handler.ts"), "export default async () => {};\n");
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });

    await installHooksFromPath({
      path: source,
      hooksDir: path.join(root, "hooks"),
      onInstallPolicyWarning,
    });

    for (const scan of [scanPackageInstallSourceMock, scanInstalledPackageDependencyTreeMock]) {
      expect(scan).toHaveBeenCalledWith(expect.objectContaining({ onInstallPolicyWarning }));
    }
  });
});
