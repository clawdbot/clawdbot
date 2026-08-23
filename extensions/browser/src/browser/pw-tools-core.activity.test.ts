// Browser tests cover Playwright observation filtering behavior.
import { describe, expect, it } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const { getConsoleMessagesViaPlaywright } = await import("./pw-tools-core.activity.js");

describe("getConsoleMessagesViaPlaywright", () => {
  it("treats the documented warn filter as warning priority", async () => {
    setPwToolsCoreCurrentPage({});
    getPwToolsCoreSessionMocks().ensurePageState.mockReturnValueOnce({
      console: [
        { type: "error", text: "error", timestamp: "1" },
        { type: "warning", text: "warning", timestamp: "2" },
        { type: "info", text: "info", timestamp: "3" },
      ],
      armIdUpload: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    });

    const messages = await getConsoleMessagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      level: "warn",
    });

    expect(messages.map((message) => message.type)).toEqual(["error", "warning"]);
  });
});
