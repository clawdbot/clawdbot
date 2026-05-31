import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";

type ApproverInput = string | number;

function dedupeDefined(values: Array<string | undefined>): string[] {
  return uniqueStrings(values.filter((value): value is string => Boolean(value)));
}

export function resolveApprovalApprovers(params: {
  explicit?: readonly ApproverInput[] | null;
  allowFrom?: readonly ApproverInput[] | null;
  extraAllowFrom?: readonly ApproverInput[] | null;
  defaultTo?: string | null;
  normalizeApprover: (value: ApproverInput) => string | undefined;
  normalizeDefaultTo?: (value: string) => string | undefined;
}): string[] {
  const explicit = dedupeDefined(
    (params.explicit ?? []).map((entry) => params.normalizeApprover(entry)),
  );
  if (explicit.length > 0) {
    return explicit;
  }

  const inferred = dedupeDefined([
    ...(params.allowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
    ...(params.extraAllowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
    ...(params.defaultTo?.trim()
      ? [
          (params.normalizeDefaultTo ?? ((value: string) => params.normalizeApprover(value)))(
            params.defaultTo.trim(),
          ),
        ]
      : []),
  ]);
  return inferred;
}
