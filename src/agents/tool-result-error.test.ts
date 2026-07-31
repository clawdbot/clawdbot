import { describe, expect, it } from "vitest";
import {
  isFileTargetNotFoundToolFailure,
  isToolResultError,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "./tool-result-error.js";

describe("isFileTargetNotFoundToolFailure", () => {
  const missingTarget = { path: "missing.txt" };
  const workspaceCwd = "/workspace";

  it("recognizes structured and textual missing-file evidence", () => {
    expect(
      isFileTargetNotFoundToolFailure(
        Object.assign(new Error("ENOENT: no such file or directory, open 'missing.txt'"), {
          code: "ENOENT",
          path: "missing.txt",
        }),
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        Object.assign(new Error("missing"), { code: "ENOENT", path: "missing.txt" }),
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { status: "failed", code: "ENOENT", error: "file not found" } },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          details: {
            status: "failed",
            code: "ENOENT",
            error: "ENOENT: no such file or directory, open 'missing.txt'",
          },
        },
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        new Error("Error: ENOENT: no such file or directory, open 'missing.txt'"),
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "cat: missing.txt: No such file or directory" },
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "[Errno 2] No such file or directory: 'missing.txt'" },
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "No such file or directory @ rb_sysopen - missing.txt" },
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error:
            "java.io.FileNotFoundException: /workspace/missing.txt (No such file or directory)",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { content: [{ type: "text", text: "File not found: missing.txt" }] },
        missingTarget,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "Sandbox FS error (ENOENT): /workspace/missing.txt" },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          path: "/workspace/missing file.txt",
          error: "Sandbox FS error (ENOENT): /workspace/missing file.txt",
        },
        { path: "missing file.txt" },
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          path: "/workspace/can't-open.txt",
          error: "ENOENT: no such file or directory, open '/workspace/can't-open.txt'",
        },
        { path: "can't-open.txt" },
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "ENOENT: no such file or directory, open '/workspace/missing.txt'" },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "open missing.txt: no such file or directory" },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(true);
  });

  it("requires both a not-found identity and the requested target", () => {
    expect(
      isFileTargetNotFoundToolFailure({ error: "spawn missing-command ENOENT" }, missingTarget),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "spawnSync missing-read-helper ENOENT",
          syscall: "spawnSync missing-read-helper",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "spawn missing-read-helper ENOENT while reading",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "spawn missing-read-helper failed",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "failed to spawn missing-read-helper",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "child_process.spawn missing-read-helper ENOENT",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          path: "missing.txt",
          message: "read helper reported spawn missing-helper ENOENT",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          error: "spawn missing-read-helper ENOENT",
          path: "missing.txt",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", path: "helper-config", message: "missing" },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          cause: {
            message: "ENOENT: no such file or directory, open '/opt/helper-config'",
          },
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", cause: { path: "/opt/helper-config" } },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { path: "/opt/helper-config", cause: { code: "ENOENT" } },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", errors: [{ path: "/opt/helper-config" }] },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error: "ENOENT: no such file or directory, open 'missing.txt'",
          cause: { path: "/opt/helper-config" },
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", cause: { path: "/workspace/missing.txt" } },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          details: { code: "ENOENT", message: "helper missing" },
          request: { path: "/workspace/missing.txt" },
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", path: "/workspace/missing.txt" },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { code: "ENOENT", cause: { syscall: "spawn missing-helper" } },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          error: "ENOENT: no such file or directory, open '/opt/helper-config'",
        },
        { path: "helper-config" },
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "No such file or directory (os error 2)" },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "ENOENT: no such file or directory" },
        { path: "file" },
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "ENOENT: no such file or directory, open 'other.txt'" },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          error: "ENOENT: no such file or directory, open '/workspace/missing.txt.bak'",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          path: "/workspace/report.txt",
          error: "ENOENT: no such file or directory, open '/workspace/report.txt'",
        },
        { path: " report.txt " },
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          path: "/workspace/ report.txt ",
          error: "ENOENT: no such file or directory, open '/workspace/ report.txt '",
        },
        { path: " report.txt " },
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        { error: "ENOENT: no such file or directory, open '/opt/helper-config'" },
        { path: "helper-config" },
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          error: "ENOENT: no such file or directory, open /opt/helper-config",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error:
            "ENOENT: no such file or directory, open 'missing.txt' (helper '/opt/helper-config')",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error:
            "ENOENT: no such file or directory, open 'missing.txt' (helper /opt/helper-config)",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          error:
            "ENOENT: no such file or directory, open 'missing.txt'\nhelper: '/opt/helper-config'",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "Failed to open 'other'",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "Failed to read 'helper-config'",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "rename 'missing.txt' to 'helper-config' failed",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "rename missing.txt to helper-config failed",
        },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message: "ENOENT: no such file or directory, open '/workspace/spawn'",
        },
        { path: "spawn" },
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          code: "ENOENT",
          message:
            "open spawn/file: no such file or directory\n    at spawn (node:child_process:1:1)",
        },
        { path: "spawn/file" },
        workspaceCwd,
      ),
    ).toBe(true);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error:
            "Failed to open 'missing.txt'\nENOENT: no such file or directory, open '/opt/helper-config'",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        {
          error:
            "Failed to open 'missing.txt': ENOENT: no such file or directory, open '/opt/helper-config'",
        },
        missingTarget,
        workspaceCwd,
      ),
    ).toBe(false);
  });

  it("fails closed when the wrapped error graph exceeds the inspection limit", () => {
    let cause: Record<string, unknown> = { path: "/opt/helper-config" };
    for (let index = 0; index < 13; index += 1) {
      cause = { cause };
    }

    expect(
      isFileTargetNotFoundToolFailure({ code: "ENOENT", cause }, missingTarget, workspaceCwd),
    ).toBe(false);
  });

  it("does not confuse other read failures with absence", () => {
    expect(
      isFileTargetNotFoundToolFailure({ details: { error: "permission denied" } }, missingTarget),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure({ details: { status: "timed_out" } }, missingTarget),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { error: "EACCES: permission denied, open '/tmp/file not found.txt'" } },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { error: "permission denied: /tmp/no such file or directory.txt" } },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { error: "permission denied: file not found.txt" } },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { error: "permission denied: /tmp/spawn missing-command ENOENT.txt" } },
        missingTarget,
      ),
    ).toBe(false);
    expect(
      isFileTargetNotFoundToolFailure(
        { details: { error: "permission denied: /tmp/(No such file or directory).txt" } },
        missingTarget,
      ),
    ).toBe(false);
  });
});

describe("isToolResultError", () => {
  it("keeps completed results with nonzero exit codes nonfatal", () => {
    expect(isToolResultError({ details: { status: "completed", exitCode: 1 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 2 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
  });

  it("keeps real failures fatal even with a completed status", () => {
    expect(isToolResultError({ details: { status: "completed", timedOut: true } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", error: "spawn failed" } })).toBe(
      true,
    );
    expect(isToolResultError({ details: { ok: false, status: "completed" } })).toBe(true);
  });

  it("keeps failure statuses and statusless nonzero exits fatal", () => {
    expect(isToolResultError({ details: { status: "failed", exitCode: 1 } })).toBe(true);
    expect(isToolResultError({ details: { status: "failed", exitCode: 127 } })).toBe(true);
    expect(isToolResultError({ details: { status: "killed", exitCode: 137 } })).toBe(true);
    expect(isToolResultError({ details: { exitCode: 1 } })).toBe(true);
  });
});

describe("resolveToolExecutionErrorKind", () => {
  it("recognizes structured timeout identities", () => {
    expect(
      resolveToolExecutionErrorKind(
        Object.assign(new Error("deadline elapsed"), { name: "TimeoutError" }),
      ),
    ).toBe("timed_out");
    expect(resolveToolExecutionErrorKind({ code: "ETIMEDOUT" })).toBe("timed_out");
    expect(resolveToolExecutionErrorKind({ reason: "timeout" })).toBe("timed_out");
  });

  it("does not infer timeout from validation text", () => {
    expect(resolveToolExecutionErrorKind(new Error("timeoutMs must be a positive number"))).toBe(
      "failed",
    );
  });

  it("contains hostile error fields", () => {
    const hostile = Object.defineProperty({}, "name", {
      get() {
        throw new Error("name getter escaped");
      },
    });
    expect(resolveToolExecutionErrorKind(hostile)).toBe("failed");
  });
});

describe("resolveToolResultFailureKind", () => {
  it("contains hostile structured result fields", () => {
    const hostileDetails = new Proxy(
      {},
      {
        has() {
          throw new Error("details field check escaped");
        },
        get() {
          throw new Error("details field getter escaped");
        },
      },
    );
    const hostileResult = Object.defineProperty({}, "details", {
      get() {
        throw new Error("details getter escaped");
      },
    });

    expect(resolveToolResultFailureKind({ details: hostileDetails })).toBeUndefined();
    expect(resolveToolResultFailureKind(hostileResult)).toBeUndefined();
  });

  it("does not classify completed nonzero exits as failures", () => {
    expect(
      resolveToolResultFailureKind({ details: { status: "completed", exitCode: 1 } }),
    ).toBeUndefined();
    expect(resolveToolResultFailureKind({ details: { status: "failed", exitCode: 1 } })).toBe(
      "failed",
    );
  });
});
