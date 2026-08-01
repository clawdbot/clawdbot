import { lazyCompile } from "./protocol-validator.js";
import {
  type ApprovalDecision,
  type ApprovalGetResult,
  ApprovalGetResultSchema,
  type ApprovalHistoryResult,
  ApprovalHistoryResultSchema,
  type ApprovalPresentation,
  type ApprovalResolveResult,
  ApprovalResolveResultSchema,
  type ApprovalSnapshot,
} from "./schema/approvals.js";

export type {
  ApprovalDecision,
  ApprovalGetResult,
  ApprovalHistoryResult,
  ApprovalPresentation,
  ApprovalResolveResult,
  ApprovalSnapshot,
};

export const validateApprovalGetResult = lazyCompile(ApprovalGetResultSchema);
export const validateApprovalHistoryResult = lazyCompile(ApprovalHistoryResultSchema);
export const validateApprovalResolveResult = lazyCompile(ApprovalResolveResultSchema);
