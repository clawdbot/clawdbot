import type {
  SkillWorkshopActionBusy,
  SkillWorkshopActionNotice,
  SkillWorkshopMode,
  SkillWorkshopProposal,
  SkillWorkshopStatusFilter,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopSelfLearning } from "./self-learning.ts";
import type { SkillWorkshopHistoryScanState } from "./state.ts";

export type SkillWorkshopProps = {
  loading: boolean;
  error: string | null;
  inspectingKey: string | null;
  proposals: SkillWorkshopProposal[];
  selectedKey: string | null;
  statusFilter: SkillWorkshopStatusFilter;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  queueWidth: number;
  mode: SkillWorkshopMode;
  actionBusy: SkillWorkshopActionBusy | null;
  actionNotice: SkillWorkshopActionNotice | null;
  revisionKey: string | null;
  revisionDraft: string;
  assistantName: string;
  workshopAgentName: string;
  selfLearning: SkillWorkshopSelfLearning | null;
  historyScan: SkillWorkshopHistoryScanState;
  counts: Record<SkillWorkshopStatusFilter, number>;
  onStatusFilterChange: (status: SkillWorkshopStatusFilter) => void;
  onRetry: () => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onQueueWidthChange: (width: number) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (key: string) => void;
  onRevise: (key: string) => void;
  onReject: (key: string) => void;
  onRevisionDraftChange: (draft: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: (key: string) => void;
  onPreviewFile: (key: string, path: string) => void;
  onClosePreview: () => void;
  onSelfLearningToggle: (enabled: boolean) => void;
  onHistoryScan: () => void;
};
