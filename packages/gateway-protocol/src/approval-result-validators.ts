import { lazyCompile } from "./protocol-validator.js";
import {
  type ApprovalDecision,
  type ApprovalGetResult,
  ApprovalGetResultSchema,
  type ApprovalPresentation,
  type ApprovalResolveResult,
  ApprovalResolveResultSchema,
  type ApprovalSnapshot,
} from "./schema/approvals.js";

export type {
  ApprovalDecision,
  ApprovalGetResult,
  ApprovalPresentation,
  ApprovalResolveResult,
  ApprovalSnapshot,
};

export const validateApprovalGetResult = lazyCompile(ApprovalGetResultSchema);
export const validateApprovalResolveResult = lazyCompile(ApprovalResolveResultSchema);
