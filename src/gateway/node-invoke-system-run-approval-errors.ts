type SystemRunApprovalGuardError = {
  ok: false;
  message: string;
  details: Record<string, unknown>;
};

export function systemRunApprovalGuardError(params: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): SystemRunApprovalGuardError {
  const details = params.details ? { ...params.details } : {};
  return {
    ok: false,
    message: params.message,
    details: {
      code: params.code,
      ...details,
    },
  };
}

export function systemRunApprovalRequired(runId: string): SystemRunApprovalGuardError {
  return systemRunApprovalGuardError({
    code: "APPROVAL_REQUIRED",
    message: "approval required",
    details: { runId },
  });
}
