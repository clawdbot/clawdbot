import type { ApplicationContext } from "../../app/context.ts";
import type {
  SkillWorkshopRevisionAdmissionEntry,
  SkillWorkshopRevisionAdmissionOutcome,
} from "../../app/skill-workshop-revision-admissions.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SkillWorkshopProposal } from "./page-types.ts";
import { resolveSkillWorkshopAgentId } from "./proposals.ts";
import { requestSkillWorkshopRevisionAdmission } from "./revision-admission.ts";
import type { SkillWorkshopState } from "./state.ts";

export class SkillWorkshopRevisionRecoveryController {
  private recoveryId: string | null = null;

  constructor(private readonly requestUpdate: () => void) {}

  get active(): boolean {
    return this.recoveryId !== null;
  }

  request(params: {
    context: ApplicationContext;
    expectedRevisionHash?: string;
    instructions: string;
    proposal: SkillWorkshopProposal;
    proposalAgentId: string;
    state: SkillWorkshopState;
  }): Promise<SkillWorkshopRevisionAdmissionOutcome> {
    const admissions = params.context.skillWorkshopRevisionAdmissions;
    const run = this.recoveryId
      ? admissions.retry(this.recoveryId)
      : admissions.start(
          {
            ...(params.expectedRevisionHash
              ? { expectedRevisionHash: params.expectedRevisionHash }
              : {}),
            instructions: params.instructions,
            proposalAgentId: params.proposalAgentId,
            proposalId: params.proposal.key,
            ...(params.proposal.origin?.agentId
              ? { proposalOriginAgentId: params.proposal.origin.agentId }
              : {}),
            ...(params.proposal.origin?.sessionKey
              ? { proposalOriginSessionKey: params.proposal.origin.sessionKey }
              : {}),
            proposalSlug: params.proposal.slug,
            useCurrentChatForRevisions: params.state.skillWorkshopUseCurrentChatForRevisions,
          },
          (entry, materialize) =>
            requestSkillWorkshopRevisionAdmission({
              context: params.context,
              entry,
              materialize,
            }),
        );
    if (!run) {
      return Promise.resolve({
        error: "Revision recovery is no longer available.",
        id: this.recoveryId ?? "missing",
        status: "retryable-failed",
      });
    }
    this.recoveryId = run.entry.id;
    return run.completion;
  }

  sync(context: ApplicationContext, state: SkillWorkshopState): void {
    if (this.recoveryId) {
      const current = context.skillWorkshopRevisionAdmissions.get(this.recoveryId);
      if (current?.phase === "retryable-failed") {
        this.restore(state, current);
        return;
      }
      if (current) {
        return;
      }
      this.recoveryId = null;
      const changed = Boolean(
        state.skillWorkshopRevisionKey ||
        state.skillWorkshopRevisionDraft ||
        state.skillWorkshopActionBusy ||
        state.skillWorkshopError,
      );
      state.skillWorkshopRevisionKey = null;
      state.skillWorkshopRevisionDraft = "";
      state.skillWorkshopActionBusy = null;
      state.skillWorkshopError = null;
      if (changed) {
        this.requestUpdate();
      }
    }
    if (state.skillWorkshopRevisionKey || state.skillWorkshopRevisionDraft) {
      return;
    }
    const recovery = context.skillWorkshopRevisionAdmissions.firstFailed(
      resolveSkillWorkshopAgentId(context),
    );
    if (recovery) {
      this.recoveryId = recovery.id;
      this.restore(state, recovery);
    }
  }

  private restore(state: SkillWorkshopState, recovery: SkillWorkshopRevisionAdmissionEntry): void {
    const error = t("skillWorkshop.revision.notAdmitted", {
      error: formatUiError(recovery.error ?? "Retry the revision request."),
    });
    const changed =
      state.skillWorkshopRevisionKey !== recovery.proposalId ||
      state.skillWorkshopRevisionDraft !== recovery.instructions ||
      state.skillWorkshopActionBusy !== null ||
      state.skillWorkshopError !== error;
    state.skillWorkshopRevisionKey = recovery.proposalId;
    state.skillWorkshopRevisionDraft = recovery.instructions;
    state.skillWorkshopActionBusy = null;
    state.skillWorkshopError = error;
    if (changed) {
      this.requestUpdate();
    }
  }
}
