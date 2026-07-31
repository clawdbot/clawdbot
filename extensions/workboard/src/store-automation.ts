import type { WorkboardAutomation, WorkboardWorkspaceAccess } from "@openclaw/workboard-contract";
// Workboard automation helpers normalize trusted host-issued workspace provenance.
import type { WorkboardLinkedCreateInput } from "./store-inputs.js";
import { normalizeAutomation, normalizeBoundedString } from "./store-normalizers.js";
import { isAbsoluteWorkspacePath } from "./workspace-path.js";

function normalizeTrustedWorkspaceAccess(
  value: unknown,
  fallback?: WorkboardWorkspaceAccess,
): WorkboardWorkspaceAccess | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace access must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.unrestricted === true) {
    return { unrestricted: true };
  }
  if (record.unrestricted !== false || !Array.isArray(record.roots)) {
    throw new Error("restricted workspace access requires roots.");
  }
  if (typeof record.writable !== "boolean") {
    throw new Error("restricted workspace access requires a writable flag.");
  }
  const roots = Array.from(
    new Set(
      record.roots.map((entry) => {
        const root = normalizeBoundedString(entry, undefined, 2000, "workspace access root");
        if (!root || !isAbsoluteWorkspacePath(root)) {
          throw new Error("workspace access roots must be absolute.");
        }
        return root;
      }),
    ),
  );
  if (roots.length === 0) {
    throw new Error("restricted workspace access requires at least one root.");
  }
  return { unrestricted: false, roots, writable: record.writable };
}

export function normalizeCardAutomation(input: WorkboardLinkedCreateInput) {
  const workspaceAccess = normalizeTrustedWorkspaceAccess(input.workspaceAccess);
  return normalizeAutomation(
    {
      tenant: input.tenant,
      boardId: input.boardId,
      createdByCardId: input.createdByCardId,
      idempotencyKey: input.idempotencyKey,
      skills: input.skills,
      workspace: input.workspace,
      maxRuntimeSeconds: input.maxRuntimeSeconds,
      maxRetries: input.maxRetries,
      scheduledAt: input.scheduledAt,
    },
    workspaceAccess ? { workspaceAccess } : undefined,
  );
}

export function normalizeAutomationPatch(
  patch: Record<string, unknown>,
  current?: WorkboardAutomation,
) {
  const workspaceAccess = Object.hasOwn(patch, "workspaceAccess")
    ? normalizeTrustedWorkspaceAccess(patch.workspaceAccess, current?.workspaceAccess)
    : current?.workspaceAccess;
  return normalizeAutomation(patch, {
    ...current,
    ...(workspaceAccess ? { workspaceAccess } : {}),
  });
}
