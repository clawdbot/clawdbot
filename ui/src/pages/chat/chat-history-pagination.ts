export type ChatHistoryPagination =
  | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
  | { hasMore: true; nextOffset: number; totalMessages?: number };
