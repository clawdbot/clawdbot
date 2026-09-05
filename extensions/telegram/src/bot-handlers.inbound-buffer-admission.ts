type TelegramBufferedDispatchOwner = {
  cancelled: boolean;
  dispatchAdmission: "pending" | "admitted" | "cancelled";
  dispatchAbortControllers: Set<AbortController>;
  pendingIgnoreSettlements: Set<Promise<void>>;
};

export function createTelegramBufferedDispatchAdmission(
  owners: readonly TelegramBufferedDispatchOwner[],
) {
  const controller = new AbortController();
  for (const owner of owners) {
    owner.dispatchAbortControllers.add(controller);
  }
  const release = () => {
    for (const owner of owners) {
      owner.dispatchAbortControllers.delete(controller);
    }
  };
  return {
    admission: {
      abortSignal: controller.signal,
      tryAdmit: () => {
        // This synchronous transition is the ownership boundary. A new authorization can land
        // after the final awaited skip check, but it cannot interleave with this all-or-none CAS.
        if (
          owners.some(
            (owner) =>
              owner.cancelled ||
              owner.dispatchAdmission === "cancelled" ||
              owner.pendingIgnoreSettlements.size > 0,
          )
        ) {
          controller.abort("skipped");
          release();
          return false;
        }
        for (const owner of owners) {
          if (owner.dispatchAdmission === "pending") {
            owner.dispatchAdmission = "admitted";
          }
        }
        const admitted = owners.every((owner) => owner.dispatchAdmission === "admitted");
        if (!admitted) {
          controller.abort("skipped");
        }
        release();
        return admitted;
      },
    },
    release,
  };
}
