export type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  fix?: boolean;
  verbose?: boolean;
};

export type MemorySearchCommandOptions = MemoryCommandOptions & {
  query?: string;
  maxResults?: number;
  minScore?: number;
};

export type MemoryPromoteCommandOptions = MemoryCommandOptions & {
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  apply?: boolean;
  includePromoted?: boolean;
};

export type MemoryPromoteExplainOptions = MemoryCommandOptions & {
  includePromoted?: boolean;
};

export type MemoryRemHarnessOptions = MemoryCommandOptions & {
  includePromoted?: boolean;
  path?: string;
  grounded?: boolean;
};

export type MemoryRemBackfillOptions = MemoryCommandOptions & {
  path?: string;
  rollback?: boolean;
  stageShortTerm?: boolean;
  rollbackShortTerm?: boolean;
};
