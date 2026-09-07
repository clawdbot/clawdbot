import type {
  SkillWorkshopAction,
  SkillWorkshopActionNotice,
  SkillWorkshopInstalledSkill,
  SkillWorkshopMode,
  SkillWorkshopProposal,
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
  skillWorkshopInstalledSkills: SkillWorkshopInstalledSkill[];
  skillWorkshopInstalledName: string | null;
  skillWorkshopSelectedKey: string | null;
  skillWorkshopActionBusy: { key: string; action: SkillWorkshopAction } | null;
  skillWorkshopActionNotice: SkillWorkshopActionNotice | null;
  skillWorkshopActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillWorkshopRevisionKey: string | null;
  skillWorkshopRevisionDraft: string;
  skillWorkshopQuery: string;
  skillWorkshopFilePreviewKey: string | null;
  skillWorkshopFilePreviewQuery: string;
  skillWorkshopQueueWidth: number;
  skillWorkshopMode: SkillWorkshopMode;
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
  | "skillWorkshopInstalledSkills"
  | "skillWorkshopInstalledName"
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
    skillWorkshopInstalledSkills: data?.skillWorkshopInstalledSkills ?? [],
    skillWorkshopInstalledName: data?.skillWorkshopInstalledName ?? null,
    skillWorkshopSelectedKey: data?.skillWorkshopSelectedKey ?? null,
    skillWorkshopActionBusy: data?.skillWorkshopActionBusy ?? null,
    skillWorkshopActionNotice: data?.skillWorkshopActionNotice ?? null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: data?.skillWorkshopRevisionKey ?? null,
    skillWorkshopRevisionDraft: data?.skillWorkshopRevisionDraft ?? "",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "skills",
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
    skillWorkshopInstalledSkills: state.skillWorkshopInstalledSkills,
    skillWorkshopInstalledName: state.skillWorkshopInstalledName,
    skillWorkshopSelectedKey: state.skillWorkshopSelectedKey,
    skillWorkshopActionBusy: state.skillWorkshopActionBusy,
    skillWorkshopActionNotice: state.skillWorkshopActionNotice,
    skillWorkshopRevisionKey: state.skillWorkshopRevisionKey,
    skillWorkshopRevisionDraft: state.skillWorkshopRevisionDraft,
    skillWorkshopHistoryScan: state.skillWorkshopHistoryScan,
  };
}
