import { randomBytes } from "node:crypto";

export type CronCreatorAuthorityGrant = Readonly<{
  runId: string;
  token: string;
}>;

export type CronCreatorAuthorityRunScope = {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly grantTokens: Set<string>;
  active: boolean;
  abort: () => void;
};

type CronCreatorAuthorityGrantEntry = {
  scope: CronCreatorAuthorityRunScope;
  operationSignal?: AbortSignal;
  onOperationAbort?: () => void;
};

const grantsByToken = new Map<string, CronCreatorAuthorityGrantEntry>();

function expiredAuthorityError(): Error & { status: number } {
  return Object.assign(
    new TypeError(
      "Configured MCP cron authority is no longer active for this run. Retry the automation mutation from the active local operator turn.",
    ),
    { name: "CronCreatorAuthorityExpiredError", status: 403 },
  );
}

export function createCronCreatorAuthorityRunScope(runId: string): CronCreatorAuthorityRunScope {
  const abortController = new AbortController();
  return {
    runId,
    signal: abortController.signal,
    grantTokens: new Set(),
    active: true,
    abort: () => abortController.abort(expiredAuthorityError()),
  };
}

export function mintCronCreatorAuthorityGrant(
  scope: CronCreatorAuthorityRunScope,
  operationSignal?: AbortSignal,
): CronCreatorAuthorityGrant {
  if (!scope.active || scope.signal.aborted || operationSignal?.aborted) {
    throw expiredAuthorityError();
  }
  const token = randomBytes(32).toString("base64url");
  const entry: CronCreatorAuthorityGrantEntry = { scope, operationSignal };
  if (operationSignal) {
    entry.onOperationAbort = () => revokeCronCreatorAuthorityGrant(token);
  }
  grantsByToken.set(token, entry);
  scope.grantTokens.add(token);
  if (operationSignal && entry.onOperationAbort) {
    operationSignal.addEventListener("abort", entry.onOperationAbort, { once: true });
  }
  return Object.freeze({ runId: scope.runId, token });
}

function revokeCronCreatorAuthorityGrant(token: string): void {
  const entry = grantsByToken.get(token);
  if (!entry) {
    return;
  }
  grantsByToken.delete(token);
  entry.scope.grantTokens.delete(token);
  if (entry.operationSignal && entry.onOperationAbort) {
    entry.operationSignal.removeEventListener("abort", entry.onOperationAbort);
  }
}

export function revokeCronCreatorAuthorityRunScope(scope: CronCreatorAuthorityRunScope): void {
  if (!scope.active) {
    return;
  }
  scope.active = false;
  scope.abort();
  for (const token of scope.grantTokens) {
    revokeCronCreatorAuthorityGrant(token);
  }
}

/** Consumes one live exact-run grant synchronously at the cron commit boundary. */
export function consumeCronCreatorAuthorityGrant(grant: CronCreatorAuthorityGrant): void {
  const runId = grant.runId.trim();
  const token = grant.token.trim();
  const entry = token ? grantsByToken.get(token) : undefined;
  if (!entry) {
    throw expiredAuthorityError();
  }
  const scope = entry.scope;
  if (
    !scope.active ||
    scope.signal.aborted ||
    entry.operationSignal?.aborted ||
    scope.runId !== runId
  ) {
    if (!scope.active || scope.signal.aborted || entry.operationSignal?.aborted) {
      revokeCronCreatorAuthorityGrant(token);
    }
    throw expiredAuthorityError();
  }
  revokeCronCreatorAuthorityGrant(token);
}
