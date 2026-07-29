export type PluginHookSkillProposalKind = "create" | "update";

export type PluginHookSkillBundleFile = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  sha256: string;
  sizeBytes: number;
};

export type PluginHookSkillBundleSnapshot = {
  skillMd: PluginHookSkillBundleFile;
  files: PluginHookSkillBundleFile[];
  treeSha256: string;
};

export type PluginHookSkillProposalEvaluateEvent = {
  proposal: {
    id: string;
    kind: PluginHookSkillProposalKind;
    revision: string;
    revisionSha256: string;
    targetCurrentSha256?: string;
  };
  skill: {
    name: string;
    skillKey: string;
    description: string;
    source?: string;
  };
  candidate: PluginHookSkillBundleSnapshot;
  baseline?: PluginHookSkillBundleSnapshot;
  reason: "created" | "revised" | "manual" | "apply";
};

export type PluginHookSkillEvaluationFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
};

export type PluginHookSkillProposalEvaluateResult = {
  summary?: string;
  findings?: PluginHookSkillEvaluationFinding[];
  metrics?: Record<string, string | number | boolean>;
  /** Version of the underlying evaluator or ruleset, separate from the plugin package. */
  evaluatorVersion?: string;
  /** Bounded evaluator mode label such as `static`, `llm`, or `baseline-comparison`. */
  mode?: string;
  decision?: "pass" | "revise" | "block";
  decisionReason?: string;
};

type PluginHookSkillProposalEvaluationAttribution = {
  evaluatorId: string;
  pluginId: string;
  pluginVersion?: string;
};

export type PluginHookSkillProposalEvaluationOutcome =
  | (PluginHookSkillProposalEvaluationAttribution & {
      status: "completed";
      result: PluginHookSkillProposalEvaluateResult;
    })
  | (PluginHookSkillProposalEvaluationAttribution & {
      status: "skipped";
    })
  | (PluginHookSkillProposalEvaluationAttribution & {
      status: "error";
      error: string;
    });

export type PluginHookSkillArtifact = {
  name: string;
  skillKey: string;
  description?: string;
  skillFile: string;
  skillDir: string;
  source: string;
  revision: {
    declaredVersion?: string;
    contentSha256: string;
    treeSha256: string;
    sourceVersion?: string;
  };
};

export type PluginHookSkillChangedEvent = {
  action: "created" | "updated" | "removed";
  source: "workshop" | "clawhub" | "source-install" | "upload";
  occurredAt: string;
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
  proposal?: {
    id: string;
    revision: string;
    revisionSha256: string;
  };
};

export type PluginHookSkillProposalChangedEvent = {
  eventId: string;
  sequence: number;
  action:
    | "created"
    | "revised"
    | "evaluation_completed"
    | "applied"
    | "rejected"
    | "quarantined"
    | "stale";
  occurredAt: string;
  correlationId?: string;
  proposal: {
    id: string;
    kind: PluginHookSkillProposalKind;
    status: "pending" | "applied" | "rejected" | "quarantined" | "stale";
    revision: string;
    revisionSha256: string;
    skillName: string;
    skillKey: string;
    skillFile: string;
    source?: string;
  };
  evaluations?: readonly PluginHookSkillProposalEvaluationOutcome[];
};

export type PluginHookSkillContext = {
  workspaceDir: string;
  agentId?: string;
};
