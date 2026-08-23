export type PluginInstallTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const PLUGIN_INSTALL_TRANSACTION = Symbol.for("openclaw.pluginInstallTransaction");
const PLUGIN_INSTALL_TRANSACTION_REQUEST = Symbol.for("openclaw.pluginInstallTransactionRequest");
const PLUGIN_INSTALL_OWNER_MIGRATIONS = Symbol.for("openclaw.pluginInstallOwnerMigrations");

type PluginInstallTransactionRequest = {
  deferCommit: true;
  transactionSink?: PluginInstallTransaction[];
};

export function attachPluginInstallTransaction<T extends object>(
  result: T,
  transaction: PluginInstallTransaction,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_TRANSACTION, {
    configurable: false,
    enumerable: true,
    value: transaction,
  });
  return result;
}

export function resolvePluginInstallTransaction(
  result: object,
): PluginInstallTransaction | undefined {
  return (result as { [PLUGIN_INSTALL_TRANSACTION]?: PluginInstallTransaction })[
    PLUGIN_INSTALL_TRANSACTION
  ];
}

export function requestDeferredPluginInstall<T extends object>(
  params: T,
  transactionSink?: PluginInstallTransaction[],
): T {
  Object.defineProperty(params, PLUGIN_INSTALL_TRANSACTION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: {
      deferCommit: true,
      ...(transactionSink ? { transactionSink } : {}),
    } satisfies PluginInstallTransactionRequest,
  });
  return params;
}

export function copyPluginInstallTransactionRequest<T extends object>(
  source: object,
  target: T,
): T {
  const request = resolvePluginInstallTransactionRequest(source);
  return request ? requestDeferredPluginInstall(target, request.transactionSink) : target;
}

function resolvePluginInstallTransactionRequest(
  params: object,
): PluginInstallTransactionRequest | undefined {
  return (params as { [PLUGIN_INSTALL_TRANSACTION_REQUEST]?: PluginInstallTransactionRequest })[
    PLUGIN_INSTALL_TRANSACTION_REQUEST
  ];
}

export function isPluginInstallCommitDeferred(params: object): boolean {
  return resolvePluginInstallTransactionRequest(params)?.deferCommit === true;
}

export function resolvePluginInstallTransactionSink(
  params: object,
): PluginInstallTransaction[] | undefined {
  return resolvePluginInstallTransactionRequest(params)?.transactionSink;
}

export function attachPluginInstallOwnerMigrations<T extends object>(
  result: T,
  migrations: Readonly<Record<string, string>>,
): T {
  Object.defineProperty(result, PLUGIN_INSTALL_OWNER_MIGRATIONS, {
    configurable: false,
    enumerable: true,
    value: migrations,
  });
  return result;
}

export function resolvePluginInstallOwnerMigrations(
  result: object,
): Readonly<Record<string, string>> | undefined {
  return (result as { [PLUGIN_INSTALL_OWNER_MIGRATIONS]?: Readonly<Record<string, string>> })[
    PLUGIN_INSTALL_OWNER_MIGRATIONS
  ];
}

export async function settlePluginInstallTransactions(
  transactions: readonly PluginInstallTransaction[],
  action: "commit" | "rollback",
): Promise<void> {
  const ordered = action === "rollback" ? transactions.toReversed() : transactions;
  const errors: unknown[] = [];
  for (const transaction of ordered) {
    try {
      await transaction[action]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Plugin install transaction ${action} failed`);
  }
}
