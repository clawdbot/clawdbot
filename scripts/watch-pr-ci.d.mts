export interface WatchPrCiArgs {
  pr: number;
  headSha: string;
  repo: string;
  after?: number;
  attachTimeout: number;
  timeout: number;
  interval: number;
}

export interface RollupCheck {
  kind: "CheckRun" | "StatusContext";
  databaseId?: number;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  checkSuite?: {
    workflowRun?: { databaseId?: number; workflow?: { databaseId?: number } } | null;
  } | null;
}

export interface RollupPayload {
  state?: string;
  contexts?: {
    totalCount?: number;
    nodes?: RollupCheck[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
}

export interface RollupPage {
  state?: string;
  mergeable?: boolean | string;
  headRefOid?: string;
  statusCheckRollup?: RollupPayload | null;
}

export interface RollupClassification {
  verdict: "GREEN" | "FAILING" | "PENDING";
  pendingCount: number;
  failingNames: string[];
  supersededCount: number;
}

export interface RunListItem {
  databaseId: number;
  createdAt: string;
}

export interface RunStatus {
  status?: string;
  conclusion?: string | null;
}

export interface RunAttachmentClassification {
  attach: boolean;
  warning?: string;
}

export interface PollUntilDeadlineOptions<T> {
  deadline: number;
  interval: number;
  poll: () => T | undefined | Promise<T | undefined>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export function parseArgs(argv: string[]): WatchPrCiArgs;
export function sanitizeCheckName(name: string): string;
export function classifyRollup(rollup: RollupPayload | null | undefined): RollupClassification;
export function collectRollupContexts(
  fetchPage: (cursor: string | null) => RollupPage | null | undefined,
): RollupPage | null | undefined;
export function buildFindRunArgs(repo: string, sha: string): string[];
export function selectRunAfter(runs: RunListItem[], after?: number): RunListItem | undefined;
export function classifyRunAttachment(
  runId: number,
  run: RunStatus,
  after?: number,
): RunAttachmentClassification;
export function pollUntilDeadline<T>(options: PollUntilDeadlineOptions<T>): Promise<T | undefined>;
