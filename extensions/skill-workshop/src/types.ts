export type SkillWorkshopStatus = "pending" | "applied" | "rejected" | "quarantined";

export type SkillChange =
  | {
      kind: "create";
      description: string;
      body: string;
    }
  | {
      kind: "append";
      section: string;
      body: string;
      description?: string;
    }
  | {
      kind: "replace";
      oldText: string;
      newText: string;
    };

export type SkillProposal = {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspaceDir: string;
  agentId?: string;
  sessionId?: string;
  skillName: string;
  title: string;
  reason: string;
  source: "agent_end" | "reviewer" | "tool";
  status: SkillWorkshopStatus;
  change: SkillChange;
  scanFindings?: SkillScanFinding[];
  quarantineReason?: string;
};

export type SkillScanFinding = {
  severity: "info" | "warn" | "critical";
  ruleId: string;
  message: string;
};
