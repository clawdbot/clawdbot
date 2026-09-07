/** Private, live control pipe of the already-owned managed updater. These
 * callbacks carry transport only; the caller must retain its recovery fences.
 */
export type ManagedServiceNativePreparation = {
  suppress: (effect: (assertCurrent: () => void) => Promise<void>) => Promise<void>;
  stop: (effect: (assertCurrent: () => void) => Promise<void>) => Promise<void>;
};
export type ManagedServiceNativeHandoff = {
  commit: (assertPersisted: () => void) => Promise<void>;
  activate: (native: ManagedServiceNativePreparation) => Promise<void>;
};

/** Admit before the first pending recovery row. An older helper must never
 * receive a stop request after that row. Negotiation does not relinquish legacy
 * completion: commit follows durable persistence, before native preparation.
 */
export async function prepareManagedServiceNativeHandoff(params: {
  assertCurrent: () => void;
  timeoutMs?: number;
}): Promise<ManagedServiceNativeHandoff | undefined> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return undefined;
  }
  let inFlight = false;
  const request = async (
    command: string,
    replies: readonly string[],
    timeoutMs: number,
    assertEffect?: () => void,
  ) => {
    if (inFlight) {
      throw new Error("Managed native control already has a pending request.");
    }
    const assertCurrent = () => {
      params.assertCurrent();
      assertEffect?.();
    };
    assertCurrent();
    inFlight = true;
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        let buffered = "";
        let failure: Error | undefined;
        // A broken pipe is not proof that a dispatched native command settled.
        // Retain the caller's physical owners until the helper positively joins it.
        const retention = assertEffect ? setInterval(() => {}, 1_000) : undefined;
        const cleanup = () => {
          settled = true;
          clearTimeout(timer);
          clearInterval(retention);
          process.stdin.off("data", onData).off("end", onEnd).off("error", fail);
          process.stdout.off("error", fail);
          process.stdin.pause();
        };
        const fail = (error: Error) => {
          if (settled) {
            return;
          }
          if (!assertEffect) {
            cleanup();
            reject(error);
          } else if (!failure) {
            failure = error;
            clearTimeout(timer);
            try {
              process.stdout.write("cancel-native\n", () => {});
            } catch {
              // Unconfirmed transport failure cannot release a native owner.
            }
          }
        };
        const onEnd = () =>
          fail(new Error("Managed native control closed before acknowledgement."));
        const onData = (chunk: Buffer) => {
          buffered += chunk.toString();
          while (buffered.includes("\n")) {
            const index = buffered.indexOf("\n") + 1;
            const line = buffered.slice(0, index);
            buffered = buffered.slice(index);
            if (assertEffect && line === "native-settled\n") {
              cleanup();
              reject(failure ?? new Error("Managed native command failed after settlement."));
              return;
            }
            if (failure) {
              continue;
            }
            if (!replies.includes(line) || buffered) {
              fail(new Error("Managed native control did not confirm the requested boundary."));
              continue;
            }
            cleanup();
            try {
              assertCurrent();
              resolve(line);
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error("Native ownership failed", { cause: error }),
              );
            }
            return;
          }
          if (buffered.length >= 96) {
            buffered = "";
            fail(new Error("Managed native control exceeded its reply limit."));
          }
        };
        const timer = setTimeout(
          () => fail(new Error("Managed native control acknowledgement timed out.")),
          timeoutMs,
        );
        process.stdin.on("data", onData).once("end", onEnd).once("error", fail);
        process.stdout.on("error", fail);
        process.stdin.resume();
        try {
          assertCurrent();
          process.stdout.write(command, (error) => {
            if (error) {
              fail(error);
            }
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      inFlight = false;
    }
  };
  const timeoutMs = params.timeoutMs ?? 360_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Managed native control requires a finite positive deadline.");
  }
  const reply = await request(
    "native-v1\n",
    ["native-v1:systemd\n", "native-v1:launchd\n", "native-v1:schtasks\n"],
    Math.min(timeoutMs, 30_000),
  );
  let committed = false;
  let commitStarted = false;
  let activated = false;
  return {
    async commit(assertPersisted) {
      if (commitStarted) {
        throw new Error("Managed recovery commit has already been consumed.");
      }
      commitStarted = true;
      params.assertCurrent();
      assertPersisted();
      await request("native-commit\n", ["native-committed\n"], Math.min(timeoutMs, 30_000));
      params.assertCurrent();
      assertPersisted();
      committed = true;
    },
    async activate(native) {
      params.assertCurrent();
      if (!committed) {
        throw new Error("Managed native control requires committed recovery persistence.");
      }
      if (activated) {
        throw new Error("Managed native control activation has already been consumed.");
      }
      activated = true;
      if (reply !== "native-v1:systemd\n") {
        await native.suppress(async (assertCurrent) => {
          await request("suppress\n", ["suppressed\n"], timeoutMs, assertCurrent);
        });
      }
      await native.stop(async (assertCurrent) => {
        await request("stop\n", ["parked\n"], timeoutMs, assertCurrent);
      });
    },
  };
}
