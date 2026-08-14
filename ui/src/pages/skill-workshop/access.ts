import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";

export type SkillWorkshopAccess = {
  canEvaluate: boolean;
  canApply: boolean;
  canRevise: boolean;
  canReject: boolean;
  canScanHistory: boolean;
};

type SkillWorkshopAdminMethod =
  | "config.patch"
  | "skills.proposals.apply"
  | "skills.proposals.evaluate"
  | "skills.proposals.historyScan"
  | "skills.proposals.reject"
  | "skills.proposals.requestRevision";

export function canCallWorkshopAdminMethod(
  snapshot: ApplicationGatewaySnapshot | null | undefined,
  method: SkillWorkshopAdminMethod,
): boolean {
  return canCallGatewayMethod(snapshot, method, "operator.admin");
}

export function resolveWorkshopAccess(snapshot: ApplicationGatewaySnapshot): SkillWorkshopAccess {
  return {
    canEvaluate: canCallWorkshopAdminMethod(snapshot, "skills.proposals.evaluate"),
    canApply: canCallWorkshopAdminMethod(snapshot, "skills.proposals.apply"),
    canRevise: canCallWorkshopAdminMethod(snapshot, "skills.proposals.requestRevision"),
    canReject: canCallWorkshopAdminMethod(snapshot, "skills.proposals.reject"),
    canScanHistory: canCallWorkshopAdminMethod(snapshot, "skills.proposals.historyScan"),
  };
}
