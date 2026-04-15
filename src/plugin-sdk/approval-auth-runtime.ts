type ResolveApprovalApproversParams = {
  explicit?: Array<string | number> | null;
  allowFrom?: Array<string | number> | null;
  extraAllowFrom?: Array<string | number> | null;
  defaultTo?: string | number | null;
  normalizeApprover?: (value: string | number) => string | undefined;
  normalizeDefaultTo?: (value: string | number) => string | undefined;
};

export function resolveApprovalApprovers(params: ResolveApprovalApproversParams): string[] {
  const values =
    params.explicit ??
    [
      ...(Array.isArray(params.allowFrom) ? params.allowFrom : []),
      ...(Array.isArray(params.extraAllowFrom) ? params.extraAllowFrom : []),
      ...(params.defaultTo != null ? [params.defaultTo] : []),
    ];
  const normalize = params.normalizeApprover ?? ((value: string | number) => String(value).trim() || undefined);
  const normalizeDefault = params.normalizeDefaultTo ?? normalize;
  const out = new Set<string>();
  for (const value of values) {
    const normalized =
      params.defaultTo != null && value === params.defaultTo ? normalizeDefault(value) : normalize(value);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out];
}

export function createResolvedApproverActionAuthAdapter(params: {
  channelLabel: string;
  resolveApprovers: (params: { cfg: unknown; accountId?: string | null }) => string[];
  normalizeSenderId?: (value: string | number) => string | undefined;
}) {
  return {
    authorizeActorAction(args: {
      cfg: unknown;
      accountId?: string | null;
      senderId?: string | number | null;
      approvalKind?: string;
    }) {
      const normalize =
        params.normalizeSenderId ?? ((value: string | number) => String(value).trim() || undefined);
      const senderId =
        args.senderId == null ? undefined : normalize(args.senderId);
      const approvers = params.resolveApprovers({
        cfg: args.cfg,
        accountId: args.accountId,
      });
      if (senderId && approvers.includes(senderId)) {
        return { authorized: true as const };
      }
      const kind = args.approvalKind === "exec" ? "exec" : "plugin";
      return {
        authorized: false as const,
        reason: `❌ You are not authorized to approve ${kind} requests on ${params.channelLabel}.`,
      };
    },
  };
}
