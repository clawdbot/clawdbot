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

export type WorkboardCardStore = WorkboardKeyedStore & {
  listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]>;
};

export function isWorkboardCardStore(store: WorkboardKeyedStore): store is WorkboardCardStore {
  return "listBoardAggregates" in store && typeof store.listBoardAggregates === "function";
}
