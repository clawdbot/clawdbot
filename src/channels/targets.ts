export type MessagingTargetKind = "user" | "channel";

export type MessagingTarget = {
  kind: MessagingTargetKind;
  id: string;
  raw: string;
  normalized: string;
};

export type MessagingTargetParseOptions = {
  defaultKind?: MessagingTargetKind;
  ambiguousMessage?: string;
};

export function normalizeTargetId(kind: MessagingTargetKind, id: string): string {
  return `${kind}:${id}`.toLowerCase();
}

export function buildMessagingTarget(
  kind: MessagingTargetKind,
  id: string,
  raw: string,
): MessagingTarget {
  return {
    kind,
    id,
    raw,
    normalized: normalizeTargetId(kind, id),
  };
}

export function ensureTargetId(params: {
  candidate: string;
  pattern: RegExp;
  errorMessage: string;
}): string {
  if (!params.pattern.test(params.candidate)) {
    throw new Error(params.errorMessage);
  }
  return params.candidate;
}

export function requireTargetKind(params: {
  platform: string;
  target: MessagingTarget | undefined;
  kind: MessagingTargetKind;
}): string {
  const kindLabel = params.kind;
  if (!params.target) {
    throw new Error(`${params.platform} ${kindLabel} id is required.`);
  }
  if (params.target.kind !== params.kind) {
    throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
  }
  return params.target.id;
}
