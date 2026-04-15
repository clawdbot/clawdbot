import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";

export type MatrixResolvedStringField =
  | "homeserver"
  | "userId"
  | "accessToken"
  | "password"
  | "deviceId"
  | "deviceName";

export type MatrixResolvedStringValues = Record<MatrixResolvedStringField, string>;

type MatrixStringSourceMap = Partial<Record<MatrixResolvedStringField, string>>;

const MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS = new Set<MatrixResolvedStringField>([
  "userId",
  "accessToken",
  "password",
  "deviceId",
]);

function resolveMatrixStringSourceValue(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

function shouldAllowBaseAuthFallback(accountId: string, field: MatrixResolvedStringField): boolean {
  return (
    normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID ||
    !MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS.has(field)
  );
}

export function resolveMatrixAccountStringValues(params: {
  accountId: string;
  account?: MatrixStringSourceMap;
  scopedEnv?: MatrixStringSourceMap;
  channel?: MatrixStringSourceMap;
  globalEnv?: MatrixStringSourceMap;
}): MatrixResolvedStringValues {
  const fields: MatrixResolvedStringField[] = [
    "homeserver",
    "userId",
    "accessToken",
    "password",
    "deviceId",
    "deviceName",
  ];
  const resolved = {} as MatrixResolvedStringValues;

  for (const field of fields) {
    resolved[field] =
      resolveMatrixStringSourceValue(params.account?.[field]) ||
      resolveMatrixStringSourceValue(params.scopedEnv?.[field]) ||
      (shouldAllowBaseAuthFallback(params.accountId, field)
        ? resolveMatrixStringSourceValue(params.channel?.[field]) ||
          resolveMatrixStringSourceValue(params.globalEnv?.[field])
        : "");
  }

  return resolved;
}
