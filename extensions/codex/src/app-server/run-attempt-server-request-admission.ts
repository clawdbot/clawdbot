export type CodexServerRequestAdmission = {
  signal: AbortSignal;
  release: () => void;
};

type AdmissionEntry = {
  controller: AbortController;
  preserveOnSeal: boolean;
};

/** Owns admission and cancellation for every server request in one Codex turn. */
export function createCodexServerRequestAdmissionController() {
  const turnController = new AbortController();
  const active = new Set<AdmissionEntry>();
  let sealed = false;
  let preservedOwner: AbortController | undefined;

  const admit = (options?: { preserveOnSeal?: boolean }): CodexServerRequestAdmission => {
    const controller = new AbortController();
    const entry = {
      controller,
      preserveOnSeal: options?.preserveOnSeal === true,
    };
    if (sealed) {
      controller.abort("codex_final_source_reply_committed");
    } else {
      active.add(entry);
    }
    return {
      signal: controller.signal,
      release: () => {
        active.delete(entry);
        if (preservedOwner === controller) {
          preservedOwner = undefined;
        }
      },
    };
  };

  const seal = (owner?: CodexServerRequestAdmission) => {
    if (sealed) {
      if (!owner && preservedOwner) {
        const controller = preservedOwner;
        preservedOwner = undefined;
        controller.abort("codex_turn_complete");
      }
      return;
    }
    sealed = true;
    turnController.abort("codex_final_source_reply_committed");
    for (const { controller, preserveOnSeal } of active) {
      if (controller.signal === owner?.signal) {
        preservedOwner = controller;
        continue;
      }
      if (!preserveOnSeal) {
        controller.abort("codex_final_source_reply_committed");
      }
    }
  };

  return {
    signal: turnController.signal,
    admit,
    seal,
  };
}
