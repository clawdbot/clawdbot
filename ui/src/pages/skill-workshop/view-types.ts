import type {
  SkillWorkshopActionBusy,
  SkillWorkshopActionNotice,
  SkillWorkshopInstalledSkill,
  SkillWorkshopInstalledSelection,
  SkillWorkshopMode,
  SkillWorkshopProposal,
  SkillWorkshopProposalDecision,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopAccess } from "./access.ts";
import type { SkillWorkshopSelfLearning } from "./self-learning.ts";
import type { SkillWorkshopHistoryScanState } from "./state.ts";

export type SkillWorkshopProps = {
  access: SkillWorkshopAccess;
  loading: boolean;
  error: string | null;
  inspectingKey: string | null;
  proposals: SkillWorkshopProposal[];
  installedSkills: SkillWorkshopInstalledSkill[];
  installedSelection: SkillWorkshopInstalledSelection;
  onSelectInstalled: (name: string) => void;
  onRetryInstalled: () => void;
  selectedKey: string | null;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  queueWidth: number;
  mode: SkillWorkshopMode;
  actionBusy: SkillWorkshopActionBusy | null;
  actionNotice: SkillWorkshopActionNotice | null;
  revisionKey: string | null;
  revisionDraft: string;
  revisionRecoveryActive: boolean;
  assistantName: string;
  workshopAgentName: string;
  selfLearning: SkillWorkshopSelfLearning | null;
  historyScan: SkillWorkshopHistoryScanState;
  onRetry: () => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onQueueWidthChange: (width: number) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (decision: SkillWorkshopProposalDecision) => void;
  onEvaluate: (key: string) => void;
  onRevise: (key: string) => void;
  onReject: (decision: SkillWorkshopProposalDecision) => void;
  onRevisionDraftChange: (draft: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: (key: string) => void;
  onPreviewFile: (key: string, path: string) => void;
  onClosePreview: () => void;
  onSelfLearningToggle: (enabled: boolean) => void;
  onHistoryScan: () => void;
};
