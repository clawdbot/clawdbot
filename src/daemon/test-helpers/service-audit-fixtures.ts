/** Shared mocks and issue helpers for the daemon service-audit tests. */
import { vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import type { SERVICE_AUDIT_CODES, ServiceConfigAudit } from "../service-audit.js";

export const execSystemctlUserMock: MockFn<
  (
    env: NodeJS.ProcessEnv,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; code: number }>
> = vi.fn();
export const resolveBunRuntimeInfoMock: MockFn = vi.fn();

/** Restores the default systemd-unavailable and WAL-safe Bun probe responses. */
export function resetServiceAuditMocks() {
  execSystemctlUserMock.mockReset();
  execSystemctlUserMock.mockResolvedValue({ stdout: "", stderr: "systemd unavailable", code: 1 });
  resolveBunRuntimeInfoMock.mockReset();
  resolveBunRuntimeInfoMock.mockResolvedValue({
    version: "1.4.0",
    sqliteVersion: "3.51.3",
    nodeSharedSqlite: false,
    status: "supported",
  });
}

export function hasIssue(
  audit: ServiceConfigAudit,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}
