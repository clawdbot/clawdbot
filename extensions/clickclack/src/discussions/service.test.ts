import { describe, expect, it, vi } from "vitest";
import { ClickClackHttpError } from "../http-client.js";
import { fallbackDiscussionLabel } from "./naming.js";
import { MANAGED_CONTRACT_FIELDS, createHarness, testExternalRef } from "./service-test-support.js";

describe("ClickClack discussion service", () => {
  it("opens a managed channel once and returns stable info URLs", async () => {
    const harness = createHarness({ label: "Release Planning", category: "Projects" });
    harness.config.channels!.clickclack!.apiBaseUrl = "http://127.0.0.1:8484";
    const sessionKey = "agent:main:main";

    expect(await harness.service.info(sessionKey)).toEqual({ state: "available" });
    const [opened, reopened] = await Promise.all([
      harness.service.open(sessionKey),
      harness.service.open(sessionKey),
    ]);

    expect(opened).toEqual({
      state: "open",
      embedUrl: "https://clickclack.example/embed/channel/team-route/discussion-route",
      openUrl: "https://clickclack.example/app/team-route/discussion-route",
    });
    expect(reopened).toEqual(opened);
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-binding-generations",
        overflowPolicy: "reject-new",
      }),
    );
    expect(harness.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-revoked-channels",
        overflowPolicy: "reject-new",
      }),
    );
    expect(harness.createChannel).toHaveBeenCalledWith("wsp_team", {
      name: "release-planning",
      kind: "public",
      external_managed: true,
      external_ref: testExternalRef(sessionKey),
      external_url: "https://control.example/control/chat?session=agent%3Amain%3Amain",
      sidebar_section: "Projects",
    });
  });

  it("pins an owning agent for an unqualified global session key", async () => {
    const harness = createHarness({ label: "Global session" });

    expect(await harness.service.open("global")).toMatchObject({ state: "open" });
    expect(harness.store.lookup("global")).toMatchObject({ agentId: "main" });
  });

  it("builds control links from URL path and query components", async () => {
    const harness = createHarness({ label: "Control link" });
    harness.config.channels!.clickclack!.discussions!.controlUrlBase =
      "https://control.example/control///?tenant=alpha#old";
    const sessionKey = "agent:main:control-link";

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({
        external_url: `https://control.example/control/chat?tenant=alpha&session=${encodeURIComponent(sessionKey)}`,
      }),
    );
  });

  it("does not create a channel for a missing session", async () => {
    const harness = createHarness(undefined);

    expect(await harness.service.open("agent:main:missing")).toEqual({ state: "available" });
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("does not create a channel without a concrete session incarnation", async () => {
    const harness = createHarness({ sessionId: "", label: "Unmaterialized session" });

    await expect(harness.service.open("agent:main:unmaterialized")).rejects.toThrow(
      "does not yet have a concrete session id",
    );

    expect(harness.client.workspaces).not.toHaveBeenCalled();
    expect(harness.channels).not.toHaveBeenCalled();
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("maps archive, label, category, restore, and deletion state to channel patches", async () => {
    const harness = createHarness({ label: "Original", category: "Projects" });
    const sessionKey = "agent:main:work";
    await harness.service.open(sessionKey);

    harness.setSessionEntry({
      label: "Renamed Session",
      category: "Incidents",
      archivedAt: 123,
    });
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).toHaveBeenLastCalledWith("chn_discussion", {
      archived: true,
      name: "renamed-session",
      sidebar_section: "Incidents",
    });

    harness.setSessionEntry({ label: "Renamed Session" });
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).toHaveBeenLastCalledWith("chn_discussion", {
      archived: false,
      sidebar_section: "Sessions",
    });

    harness.setSessionEntry(undefined);
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).toHaveBeenLastCalledWith("chn_discussion", { archived: true });
    expect(await harness.service.info(sessionKey)).toEqual({ state: "available" });
  });

  it("does not return a binding removed while info or open reconciles a deleted session", async () => {
    const infoHarness = createHarness({ label: "Info deletion" });
    const infoKey = "agent:main:deleted-info";
    await infoHarness.service.open(infoKey);
    infoHarness.setSessionEntry(undefined);
    expect(await infoHarness.service.info(infoKey)).toEqual({ state: "available" });

    const openHarness = createHarness({ label: "Open deletion" });
    const openKey = "agent:main:deleted-open";
    await openHarness.service.open(openKey);
    openHarness.setSessionEntry(undefined);
    expect(await openHarness.service.open(openKey)).toEqual({ state: "available" });
  });

  it("archives and replaces a binding when the session key gets a new incarnation", async () => {
    const harness = createHarness({ sessionId: "session-old", label: "Resettable" });
    const sessionKey = "agent:main:resettable";
    await harness.service.open(sessionKey);
    const oldRef = testExternalRef(sessionKey, "session-old");

    harness.setSessionEntry({ sessionId: "session-new", label: "Resettable" });
    expect((await harness.service.readLatestMessages(sessionKey, 30)).text).toBe(
      "No discussion is bound to this session.",
    );

    expect(await harness.service.open(sessionKey)).toMatchObject({ state: "open" });
    const newRef = testExternalRef(sessionKey, "session-new");
    expect(newRef).not.toBe(oldRef);
    expect(harness.updateChannel).toHaveBeenCalledWith("chn_discussion", { archived: true });
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.createChannel).toHaveBeenLastCalledWith(
      "wsp_team",
      expect.objectContaining({ external_ref: newRef }),
    );
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      externalRef: newRef,
    });
  });

  it("archives an unbound channel when the session resets during open", async () => {
    const harness = createHarness({ sessionId: "session-old", label: "Reset race" });
    const sessionKey = "agent:main:reset-race";
    vi.mocked(harness.runtime.agent.session.getSessionEntry)
      .mockReturnValueOnce({ sessionId: "session-old", label: "Reset race", updatedAt: 1 })
      .mockReturnValue({ sessionId: "session-new", label: "Reset race", updatedAt: 2 });

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "OpenClaw session changed while opening",
    );
    expect(harness.updateChannel).toHaveBeenCalledWith("chn_discussion", { archived: true });
    expect(harness.store.lookup(sessionKey)).toBeUndefined();
  });

  it("uses the short session fallback when a label slug already exists", async () => {
    const harness = createHarness({ label: "Release Planning" });
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_existing",
        route_id: "existing-route",
        workspace_id: "wsp_team",
        name: "release-planning",
        kind: "public",
        ...MANAGED_CONTRACT_FIELDS,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);

    await harness.service.open("agent:main:duplicate-label");

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ name: fallbackDiscussionLabel("agent:main:duplicate-label") }),
    );
  });

  it("adds a deterministic suffix when both the label and hash fallback are occupied", async () => {
    const harness = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:duplicate-label";
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_existing_label",
        route_id: "existing-label-route",
        workspace_id: "wsp_team",
        name: "release-planning",
        kind: "public",
        ...MANAGED_CONTRACT_FIELDS,
        created_at: "2026-07-19T00:00:00.000Z",
      },
      {
        id: "chn_existing_hash",
        route_id: "existing-hash-route",
        workspace_id: "wsp_team",
        name: fallbackDiscussionLabel(sessionKey),
        kind: "public",
        ...MANAGED_CONTRACT_FIELDS,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ name: `${fallbackDiscussionLabel(sessionKey)}-2` }),
    );
  });

  it("relists and retries when another process claims the selected create name", async () => {
    const harness = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:create-race";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockResolvedValueOnce([
        general,
        {
          ...general,
          id: "chn_human",
          route_id: "human-route",
          name: "release-planning",
        },
      ]);
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        400,
        "UNIQUE constraint failed: channels.workspace_id, channels.name",
        new Headers(),
      ),
    );

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.createChannel).toHaveBeenLastCalledWith(
      "wsp_team",
      expect.objectContaining({ name: fallbackDiscussionLabel(sessionKey) }),
    );
  });

  it("relists and retries when another process claims the selected rename", async () => {
    const harness = createHarness({ label: "Original" });
    const sessionKey = "agent:main:rename-race";
    await harness.service.open(sessionKey);
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockResolvedValueOnce([
        general,
        {
          ...general,
          id: "chn_human",
          route_id: "human-route",
          name: "renamed",
        },
      ]);
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        409,
        'duplicate key value violates unique constraint "channels_workspace_id_name_key"',
        new Headers(),
      ),
    );
    harness.setSessionEntry({ label: "Renamed" });

    await harness.service.reconcile(sessionKey);

    expect(harness.updateChannel).toHaveBeenCalledTimes(2);
    expect(harness.updateChannel).toHaveBeenLastCalledWith(
      "chn_discussion",
      expect.objectContaining({ name: fallbackDiscussionLabel(sessionKey) }),
    );
  });

  it("adopts a remotely created channel by external reference after an interrupted open", async () => {
    const harness = createHarness({ label: "Release Planning", category: "Projects" });
    const sessionKey = "agent:main:recover";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_recovered",
        route_id: "recovered-route",
        workspace_id: "wsp_team",
        name: "release-planning",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: `https://control.example/control/chat?session=${encodeURIComponent(sessionKey)}`,
        sidebar_section: "Projects",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) => ({
      id: "chn_recovered",
      route_id: "recovered-route",
      workspace_id: "wsp_team",
      name: patch.name ?? "release-planning",
      kind: "public",
      external_managed: patch.external_managed,
      external_ref: patch.external_ref,
      external_url: patch.external_url,
      sidebar_section: patch.sidebar_section,
      archived: patch.archived,
      created_at: "2026-07-19T00:00:00.000Z",
    }));

    const opened = await harness.service.open(sessionKey);

    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_recovered",
      expect.objectContaining({ external_ref: externalRef, external_managed: true }),
    );
    expect(opened).toEqual({
      state: "open",
      embedUrl: "https://clickclack.example/embed/channel/team-route/recovered-route",
      openUrl: "https://clickclack.example/app/team-route/recovered-route",
    });
  });

  it("reuses a pending generation after an interrupted create", async () => {
    const generationFactory = vi.fn(() => "pending-generation");
    const harness = createHarness(
      { label: "Interrupted create" },
      { bindingGenerationFactory: generationFactory },
    );
    const sessionKey = "agent:main:interrupted-create";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const firstRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      generation: "pending-generation",
    });

    await harness.service.reconcileAll();

    expect(harness.createChannel.mock.calls[1]?.[1].external_ref).toBe(firstRef);
    expect(generationFactory).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("does not transfer a pending open across credential rotation", async () => {
    const harness = createHarness({ label: "Credential rotation" });
    const sessionKey = "agent:main:credential-rotation";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const pendingBeforeRotation = harness.generationStore.lookup(sessionKey);
    harness.config.channels!.clickclack!.token = "test-token-placeholder";

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "restore its credential and retry",
    );

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toEqual(pendingBeforeRotation);
  });

  it("adopts a created channel when the create response is lost", async () => {
    const harness = createHarness({ label: "Lost response" });
    const sessionKey = "agent:main:lost-response";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockImplementationOnce(async () => {
        const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
        return [
          general,
          {
            id: "chn_lost_response",
            route_id: "lost-response-route",
            workspace_id: "wsp_team",
            name: "lost-response",
            kind: "public",
            external_managed: true,
            external_ref: externalRef,
            external_url: "",
            sidebar_section: "Sessions",
            archived: false,
            created_at: "2026-07-19T00:00:00.000Z",
          },
        ];
      });
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) => ({
      id: "chn_lost_response",
      route_id: "lost-response-route",
      workspace_id: "wsp_team",
      name: patch.name ?? "lost-response",
      kind: "public",
      external_managed: patch.external_managed ?? true,
      external_ref: patch.external_ref ?? "",
      external_url: patch.external_url ?? "",
      sidebar_section: patch.sidebar_section ?? "Sessions",
      archived: patch.archived ?? false,
      created_at: "2026-07-19T00:00:00.000Z",
    }));

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_lost_response",
      expect.objectContaining({ external_managed: true }),
    );
    expect(harness.store.lookup(sessionKey)).toMatchObject({ channelId: "chn_lost_response" });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("releases a pending destination after a definitive create rejection", async () => {
    const harness = createHarness({ label: "Forbidden create" });
    const sessionKey = "agent:main:forbidden-create";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(403, "forbidden", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("retains a pending destination after an ambiguous HTTP create failure", async () => {
    const harness = createHarness({ label: "Server failure" });
    const sessionKey = "agent:main:server-failure";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(500, "internal error", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "ClickClack 500: internal error",
    );

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
  });

  it("retains a pending destination when a transport failure relists empty", async () => {
    const harness = createHarness({ label: "Delayed commit" });
    const sessionKey = "agent:main:delayed-commit";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection reset"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection reset");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
  });

  it("retains a recovered channel reservation when its adoption patch fails", async () => {
    const harness = createHarness({ label: "Adoption failure" });
    const sessionKey = "agent:main:adoption-failure";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockImplementationOnce(async () => {
        const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
        return [
          general,
          {
            id: "chn_adoption_failure",
            route_id: "adoption-failure-route",
            workspace_id: "wsp_team",
            name: "adoption-failure",
            kind: "public",
            external_managed: true,
            external_ref: externalRef,
            external_url: "",
            sidebar_section: "Sessions",
            archived: false,
            created_at: "2026-07-19T00:00:00.000Z",
          },
        ];
      });
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection reset"));
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(new Error("patch unavailable"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection reset");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("retains a pre-existing channel reservation after definitive adoption failures", async () => {
    const harness = createHarness({ label: "Existing adoption failure" });
    const sessionKey = "agent:main:existing-adoption-failure";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_existing_adoption_failure",
        route_id: "existing-adoption-failure-route",
        workspace_id: "wsp_team",
        name: "existing-adoption-failure",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);
    vi.mocked(harness.updateChannel).mockRejectedValue(
      new ClickClackHttpError(403, "forbidden", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ externalRef }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("retains an adopted channel reservation when conflict relisting fails", async () => {
    const harness = createHarness({ label: "Adopted conflict" });
    const sessionKey = "agent:main:adopted-conflict";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([
        {
          id: "chn_adopted_conflict",
          route_id: "adopted-conflict-route",
          workspace_id: "wsp_team",
          name: "adopted-conflict",
          kind: "public",
          external_managed: true,
          external_ref: externalRef,
          external_url: "",
          sidebar_section: "Sessions",
          archived: false,
          created_at: "2026-07-19T00:00:00.000Z",
        },
      ])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        409,
        'duplicate key value violates unique constraint "channels_workspace_id_name_key"',
        new Headers(),
      ),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("relist unavailable");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ externalRef }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("archives an ambiguous create after the session incarnation changes", async () => {
    const harness = createHarness({ sessionId: "old-session", label: "Ambiguous reset" });
    const sessionKey = "agent:main:ambiguous-reset";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.setSessionEntry({ sessionId: "new-session", label: "Ambiguous reset" });
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_ambiguous_old",
        route_id: "ambiguous-old-route",
        workspace_id: "wsp_team",
        name: "ambiguous-reset",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);

    await harness.service.open(sessionKey);

    expect(harness.updateChannel).toHaveBeenCalledWith("chn_ambiguous_old", { archived: true });
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.createChannel.mock.calls[1]?.[1].external_ref).not.toBe(externalRef);
    expect(harness.store.lookup(sessionKey)).toMatchObject({ sessionId: "new-session" });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("reconciles an ambiguous create after discussions are disabled", async () => {
    const harness = createHarness({ label: "Disable during create" });
    const sessionKey = "agent:main:disable-during-create";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.config.channels!.clickclack!.discussions!.enabled = false;
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_disabled_pending",
        route_id: "disabled-pending-route",
        workspace_id: "wsp_team",
        name: "disable-during-create",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);

    await harness.service.reconcileAll();

    expect(harness.updateChannel).toHaveBeenCalledWith("chn_disabled_pending", { archived: true });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("does not recurse while replacing the account for an ambiguous open", async () => {
    const harness = createHarness({ label: "Account replacement" });
    const sessionKey = "agent:main:account-replacement";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.config.channels!.clickclack!.discussions!.enabled = false;
    harness.config.channels!.clickclack!.accounts = {
      replacement: {
        baseUrl: "https://replacement-clickclack.example",
        token: "test-token-placeholder",
        workspace: "team",
        discussions: { enabled: true, workspace: "team" },
      },
    };
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_old_account",
        route_id: "old-account-route",
        workspace_id: "wsp_team",
        name: "account-replacement",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.updateChannel).toHaveBeenCalledWith("chn_old_account", { archived: true });
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      accountId: "replacement",
      serverBaseUrl: "https://replacement-clickclack.example",
    });
  });

  it("rejects adoption when the server ignores the requested lifecycle state", async () => {
    const harness = createHarness({ label: "Recovered Name", archivedAt: 123 });
    const sessionKey = "agent:main:recover-stale";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels).mockResolvedValue([
      {
        id: "chn_recovered",
        route_id: "recovered-route",
        workspace_id: "wsp_team",
        name: "old-name",
        kind: "public",
        external_managed: true,
        external_ref: externalRef,
        external_url: `https://control.example/control/chat?session=${encodeURIComponent(sessionKey)}`,
        sidebar_section: "Sessions",
        archived: false,
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]);
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) => ({
      id: "chn_recovered",
      route_id: "recovered-route",
      workspace_id: "wsp_team",
      name: "old-name",
      kind: "public",
      external_managed: patch.external_managed,
      external_ref: patch.external_ref,
      external_url: patch.external_url,
      sidebar_section: patch.sidebar_section,
      archived: false,
      created_at: "2026-07-19T00:00:00.000Z",
    }));

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "ClickClack channel update did not apply archived",
    );
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });
});
