// Workboard plugin module implements persistence types behavior.
import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardNotificationSubscription,
} from "@openclaw/workboard-contract";

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

export type WorkboardBoardCardAggregate = {
  boardId: string;
  status: WorkboardCard["status"];
  total: number;
  archived: number;
  updatedAt: number;
};

export type WorkboardOwnerClaimResult = "updated" | "conflict" | "owner_busy";

export type WorkboardCardStore = WorkboardKeyedStore & {
  registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean>;
  registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean>;
  claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
  ): Promise<WorkboardOwnerClaimResult>;
  listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]>;
};

export function isWorkboardCardStore(store: WorkboardKeyedStore): store is WorkboardCardStore {
  return (
    "listBoardAggregates" in store &&
    typeof store.listBoardAggregates === "function" &&
    "registerIfAbsent" in store &&
    typeof store.registerIfAbsent === "function" &&
    "registerIfUpdatedAt" in store &&
    typeof store.registerIfUpdatedAt === "function" &&
    "claimIfOwnerAvailable" in store &&
    typeof store.claimIfOwnerAvailable === "function"
  );
}
