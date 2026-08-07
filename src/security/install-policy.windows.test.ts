import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PermissionCheck } from "./audit-fs.js";
import { validateInstallPolicyStatic } from "./install-policy.js";

const auditMocks = vi.hoisted(() => ({
  inspectPathPermissions: vi.fn(),
}));

vi.mock("./audit-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit-fs.js")>();
  return {
    ...actual,
    inspectPathPermissions: auditMocks.inspectPathPermissions,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function permissions(source: PermissionCheck["source"]): PermissionCheck {
  return {
    ok: true,
    isSymlink: false,
    isDir: false,
    mode: 0o700,
    bits: 0,
    source,
    worldWritable: false,
    groupWritable: false,
    worldReadable: false,
    groupReadable: false,
  };
}

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  auditMocks.inspectPathPermissions.mockResolvedValue(permissions("windows-acl"));
});

afterEach(() => {
  vi.restoreAllMocks();
  auditMocks.inspectPathPermissions.mockReset();
});

describe("install policy Windows ACL diagnostics", () => {
  it.each([
    { kind: "file", unavailablePath: (scriptPath: string) => scriptPath },
    { kind: "parent directory", unavailablePath: (scriptPath: string) => path.dirname(scriptPath) },
  ])("identifies the interpreter script when its $kind ACL is unavailable", async (fixture) => {
    const dir = tempDirs.make("openclaw-install-policy-windows-");
    const scriptPath = path.join(dir, "policy.cjs");
    await fs.writeFile(scriptPath, "export {};\n", "utf8");
    const unavailablePath = fixture.unavailablePath(scriptPath);
    auditMocks.inspectPathPermissions.mockImplementation(async (targetPath: string) =>
      permissions(targetPath === unavailablePath ? "unknown" : "windows-acl"),
    );

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: [scriptPath],
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.args[0]${fixture.kind === "parent directory" ? " parent directory" : ""} ACL verification unavailable on Windows for ${unavailablePath}. Move security.installPolicy.exec.args[0] to a direct path whose ACLs can be verified.`,
    );
  });
});
