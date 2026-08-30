import { IDBDatabase as FakeIndexedDbDatabase } from "fake-indexeddb";

// Matrix SDK helper mitigates fake-indexeddb finished-transaction retention.
const MATRIX_CRYPTO_DATABASE_SUFFIXES = [
  "::matrix-sdk-crypto",
  "::matrix-sdk-crypto-meta",
] as const;
const PRUNER_INSTALLED = Symbol.for("openclaw.matrix.fakeIndexedDbTransactionPruner");

type FakeIndexedDbTransaction = IDBTransaction & {
  _state: string;
};

type FakeIndexedDbRawDatabase = {
  name: string;
  transactions: FakeIndexedDbTransaction[];
};

type FakeIndexedDbDatabaseConnection = IDBDatabase & {
  _rawDatabase: FakeIndexedDbRawDatabase;
};

type FakeIndexedDbDatabasePrototype = IDBDatabase & {
  [PRUNER_INSTALLED]?: true;
};

function isMatrixCryptoDatabase(rawDatabase: FakeIndexedDbRawDatabase): boolean {
  return MATRIX_CRYPTO_DATABASE_SUFFIXES.some((suffix) => rawDatabase.name.endsWith(suffix));
}

function pruneFinishedFakeIndexedDbTransactions(rawDatabase: FakeIndexedDbRawDatabase): number {
  if (!isMatrixCryptoDatabase(rawDatabase)) {
    return 0;
  }

  const transactions = rawDatabase.transactions;
  const activeTransactions = transactions.filter(
    (transaction) => transaction["_state"] !== "finished",
  );
  const removed = transactions.length - activeTransactions.length;
  if (removed > 0) {
    transactions.splice(0, transactions.length, ...activeTransactions);
  }
  return removed;
}

export function installFakeIndexedDbTransactionPruner(): void {
  const databasePrototype = FakeIndexedDbDatabase.prototype as FakeIndexedDbDatabasePrototype;
  if (databasePrototype[PRUNER_INSTALLED]) {
    return;
  }

  Object.defineProperty(databasePrototype, PRUNER_INSTALLED, {
    configurable: false,
    enumerable: false,
    value: true,
  });

  const originalTransaction = Object.getOwnPropertyDescriptor(databasePrototype, "transaction")
    ?.value as IDBDatabase["transaction"];
  databasePrototype.transaction = function patchedMatrixFakeIndexedDbTransaction(
    this: FakeIndexedDbDatabaseConnection,
    ...args: Parameters<IDBDatabase["transaction"]>
  ): ReturnType<IDBDatabase["transaction"]> {
    const rawDatabase = this["_rawDatabase"];
    pruneFinishedFakeIndexedDbTransactions(rawDatabase);

    const transaction = originalTransaction.apply(this, args) as FakeIndexedDbTransaction;
    if (isMatrixCryptoDatabase(rawDatabase)) {
      const prune = (): void => {
        pruneFinishedFakeIndexedDbTransactions(rawDatabase);
      };
      transaction.addEventListener("complete", prune);
      transaction.addEventListener("abort", prune);
    }

    return transaction;
  } as IDBDatabase["transaction"];
}
