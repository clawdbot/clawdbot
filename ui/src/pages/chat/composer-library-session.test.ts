// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { buildSkillLibraryMock } from "../../test-helpers/skill-library-fixtures.ts";
import { ComposerLibrarySession } from "./composer-library-session.ts";

const read = buildSkillLibraryMock()[0];
const sessionKey = "agent:main:alice";
const list: SkillsLibraryListResult = {
  entries: [],
  profileId: "profile-bob",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
  session: { sessionKey, selections: [], attachable: [] },
};
const activated: SkillsLibraryActivateResult = {
  sessionKey,
  selections: [],
  sessionActivation: "next-turn",
};

describe("composer session library ownership", () => {
  it.each(["list", "read", "activate"] as const)(
    "discards a late %s result after the viewer connection changes",
    async (operation) => {
      const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
      let resolve!: (
        value: SkillsLibraryListResult | SkillsLibraryReadResult | SkillsLibraryActivateResult,
      ) => void;
      const deferred = new Promise<
        SkillsLibraryListResult | SkillsLibraryReadResult | SkillsLibraryActivateResult
      >((done) => {
        resolve = done;
      });
      const request = vi.spyOn(client, "request").mockImplementationOnce(async () => deferred);
      const library = new ComposerLibrarySession(vi.fn());
      let epoch = 1;
      library.synchronize({
        client,
        connectionEpoch: 1,
        sessionKey,
        agentId: "main",
        isCurrent: () => epoch === 1,
      });
      const pending =
        operation === "list"
          ? library.load()
          : operation === "read"
            ? library.openRead(read.entry.skillId, read.entry.revision)
            : library.activate("detach", read.entry.skillId);
      epoch = 2;
      library.synchronize({
        client,
        connectionEpoch: 2,
        sessionKey,
        agentId: "main",
        isCurrent: () => epoch === 2,
      });
      resolve(operation === "list" ? list : operation === "read" ? read : activated);
      await pending;
      expect(library.result).toBeNull();
      expect(library.read).toBeNull();
      expect(library.notice).toBeNull();
      expect(library.busy).toBe(false);
      expect(library.loading).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      request.mockResolvedValue(list);
      await library.load();
      expect(library.result).toEqual(list);
      expect(request).toHaveBeenLastCalledWith("skills.library.list", { sessionKey });
      request.mockRestore();
    },
  );
});
