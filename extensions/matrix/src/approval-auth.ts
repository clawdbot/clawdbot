// Matrix plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

const matrixApproval = createChannelApprovalAuth({
  channelLabel: "Matrix",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
    return { allowFrom: account.config.dm?.allowFrom };
  },
  normalizeApprover: normalizeMatrixApproverId,
});

export const getMatrixApprovalAuthApprovers = matrixApproval.resolveApprovers;
export const matrixApprovalAuth = matrixApproval.approvalAuth;
