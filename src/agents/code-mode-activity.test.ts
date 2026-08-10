import { describe, expect, it } from "vitest";
import {
  beginCodeModeBridgeActivity,
  beginCodeModeControlActivity,
  createCodeModeActivityOwner,
  discardCodeModeRunActivity,
  registerCodeModeRunActivity,
  retainCodeModeRunActivityUntilSettlement,
  sampleCodeModeRunFinalQuiescence,
  waitForCodeModeRunActivitySettlement,
} from "./code-mode-activity.js";

describe("Code Mode run activity", () => {
  it("reports unavailable when the command did not register an observer", () => {
    const owner = createCodeModeActivityOwner();

    expect(Object.isFrozen(owner)).toBe(true);
    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("unavailable");
  });

  it("keeps an idle registered observer unavailable until Code Mode does work", () => {
    const owner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(owner);

    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("unavailable");

    beginCodeModeControlActivity(owner)();
    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("quiescent");
  });

  it("isolates late releases by frozen owner identity", () => {
    const oldOwner = createCodeModeActivityOwner();
    const currentOwner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(oldOwner);
    const releaseOldBridge = beginCodeModeBridgeActivity(oldOwner);
    discardCodeModeRunActivity(oldOwner);

    registerCodeModeRunActivity(currentOwner);
    const releaseCurrentControl = beginCodeModeControlActivity(currentOwner);
    releaseOldBridge();
    expect(sampleCodeModeRunFinalQuiescence(currentOwner)).toBe("non_quiescent");

    releaseCurrentControl();
    expect(sampleCodeModeRunFinalQuiescence(currentOwner)).toBe("quiescent");
  });

  it("waits for the last owned activity to settle", async () => {
    const owner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(owner);
    const releaseControl = beginCodeModeControlActivity(owner);
    const releaseBridge = beginCodeModeBridgeActivity(owner);
    let settled = false;
    const settlement = waitForCodeModeRunActivitySettlement(owner).then(() => {
      settled = true;
    });

    releaseControl();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseBridge();
    await settlement;
    expect(settled).toBe(true);
    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("quiescent");
  });

  it("retains an owner and releases it synchronously with physical settlement", () => {
    const owner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(owner);
    const releaseBridge = beginCodeModeBridgeActivity(owner);
    let settled = false;

    expect(
      retainCodeModeRunActivityUntilSettlement(owner, () => {
        settled = true;
        discardCodeModeRunActivity(owner);
      }),
    ).toBe(true);
    expect(settled).toBe(false);

    releaseBridge();

    expect(settled).toBe(true);
    expect(sampleCodeModeRunFinalQuiescence(owner)).toBe("unavailable");
  });
});
