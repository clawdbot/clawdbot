import type {
  SkillWorkshopAction,
  SkillWorkshopActionNotice,
  SkillWorkshopMode,
  SkillWorkshopProposal,
  SkillWorkshopStatusFilter,
} from "../../lib/skill-workshop/index.ts";

export type SkillWorkshopHistoryScanResult = {
  schema: "openclaw.skill-workshop.history-scan.v1";
  hasScanned: boolean;
  reviewedSessions: number;
  ideasFound: number;
  hasMore: boolean;
  lastScanReviewed: number;
  lastScanIdeas: number;
  lastScanAt?: string;
  oldestReviewedAt?: string;
  newestReviewedAt?: string;
};

export type SkillWorkshopHistoryScanState = {
  loading: boolean;
  loaded: boolean;
  running: boolean;
  error: string | null;
  result: SkillWorkshopHistoryScanResult | null;
};

export function createSkillWorkshopHistoryScanState(): SkillWorkshopHistoryScanState {
  return {
    loading: false,
    loaded: false,
    running: false,
    error: null,
    result: null,
  };
}

export type SkillWorkshopState = {
  skillWorkshopAgentId: string | null;
  skillWorkshopLoading: boolean;
  skillWorkshopLoaded: boolean;
  skillWorkshopError: string | null;
  skillWorkshopInspectingKey: string | null;
  skillWorkshopProposals: SkillWorkshopProposal[];
  skillWorkshopSelectedKey: string | null;
  skillWorkshopActionBusy: { key: string; action: SkillWorkshopAction } | null;
  skillWorkshopActionNotice: SkillWorkshopActionNotice | null;
  skillWorkshopActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillWorkshopRevisionKey: string | null;
  skillWorkshopRevisionDraft: string;
  skillWorkshopStatusFilter: SkillWorkshopStatusFilter;
  skillWorkshopQuery: string;
  skillWorkshopFilePreviewKey: string | null;
  skillWorkshopFilePreviewQuery: string;
  skillWorkshopQueueWidth: number;
  skillWorkshopMode: SkillWorkshopMode;
  skillWorkshopUseCurrentChatForRevisions: boolean;
  skillWorkshopHistoryScan: SkillWorkshopHistoryScanState;
};

export type SkillWorkshopRouteData = Pick<
  SkillWorkshopState,
  | "skillWorkshopAgentId"
  | "skillWorkshopLoading"
  | "skillWorkshopLoaded"
  | "skillWorkshopError"
  | "skillWorkshopInspectingKey"
  | "skillWorkshopProposals"
  | "skillWorkshopSelectedKey"
  | "skillWorkshopActionBusy"
  | "skillWorkshopActionNotice"
  | "skillWorkshopRevisionKey"
  | "skillWorkshopRevisionDraft"
  | "skillWorkshopHistoryScan"
>;

export function createSkillWorkshopState(data?: SkillWorkshopRouteData): SkillWorkshopState {
  return {
    skillWorkshopAgentId: data?.skillWorkshopAgentId ?? null,
    skillWorkshopLoading: data?.skillWorkshopLoading ?? false,
    skillWorkshopLoaded: data?.skillWorkshopLoaded ?? false,
    skillWorkshopError: data?.skillWorkshopError ?? null,
    skillWorkshopInspectingKey: data?.skillWorkshopInspectingKey ?? null,
    skillWorkshopProposals: data?.skillWorkshopProposals ?? [],
    skillWorkshopSelectedKey: data?.skillWorkshopSelectedKey ?? null,
    skillWorkshopActionBusy: data?.skillWorkshopActionBusy ?? null,
    skillWorkshopActionNotice: data?.skillWorkshopActionNotice ?? null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: data?.skillWorkshopRevisionKey ?? null,
    skillWorkshopRevisionDraft: data?.skillWorkshopRevisionDraft ?? "",
    skillWorkshopStatusFilter: "pending",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "today",
    skillWorkshopUseCurrentChatForRevisions: false,
    skillWorkshopHistoryScan:
      data?.skillWorkshopHistoryScan ?? createSkillWorkshopHistoryScanState(),
  };
}

export function skillWorkshopRouteData(state: SkillWorkshopState): SkillWorkshopRouteData {
  return {
    skillWorkshopAgentId: state.skillWorkshopAgentId,
    skillWorkshopLoading: state.skillWorkshopLoading,
    skillWorkshopLoaded: state.skillWorkshopLoaded,
    skillWorkshopError: state.skillWorkshopError,
    skillWorkshopInspectingKey: state.skillWorkshopInspectingKey,
    skillWorkshopProposals: state.skillWorkshopProposals,
    skillWorkshopSelectedKey: state.skillWorkshopSelectedKey,
    skillWorkshopActionBusy: state.skillWorkshopActionBusy,
    skillWorkshopActionNotice: state.skillWorkshopActionNotice,
    skillWorkshopRevisionKey: state.skillWorkshopRevisionKey,
    skillWorkshopRevisionDraft: state.skillWorkshopRevisionDraft,
    skillWorkshopHistoryScan: state.skillWorkshopHistoryScan,
  };
}
