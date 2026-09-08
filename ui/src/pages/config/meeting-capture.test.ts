import type { TranscriptsStatusResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import "./meeting-capture.ts";

type CaptureElement = HTMLElement & {
  context: ApplicationContext;
  mutationDisabled: boolean;
  updateComplete: Promise<boolean>;
};
const configs: RuntimeConfigCapability[] = [];
const requiredProviders: TranscriptsStatusResult["providers"] = meetingStatus.providers.map(
  (provider) => ({
    ...provider,
    autoStart: {
      accountId: "required",
      guildId: "required",
      channelId: "required",
      meetingUrl: "required",
    },
  }),
);

async function mount(
  options: {
    source?: Record<string, unknown>;
    disabled?: boolean;
    failStatus?: boolean;
    providers?: TranscriptsStatusResult["providers"];
    startDiagnostic?: TranscriptsStatusResult["configuredSources"][number]["startDiagnostic"];
  } = {},
) {
  const original = options.source ?? {
    providerId: "test-voice",
    accountId: "team",
    guildId: "guild",
    channelId: "room",
    meetingUrl: "https://example.test/meeting",
    title: "Original title",
    sessionId: "custom-session",
  };
  const config = {
    transcripts: { enabled: true, autoStart: [original] },
    messages: { ackReaction: "ok" },
  };
  const respond = async (method: string, _params?: { raw?: string; baseHash?: string }) => {
    if (method === "transcripts.status") {
      if (options.failStatus) {
        throw new Error("Archive unavailable");
      }
      const status: TranscriptsStatusResult = {
        ...meetingStatus,
        providers: options.providers ?? meetingStatus.providers,
        configuredSources: meetingStatus.configuredSources.map((source) => ({
          ...source,
          startDiagnostic: options.startDiagnostic,
        })),
      };
      return status;
    }
    if (method === "config.get") {
      return {
        config,
        hash: "one",
        appliedConfigHash: "one",
        valid: true,
        issues: [],
        raw: JSON.stringify(config),
      };
    }
    if (method === "config.set") {
      return { hash: "two" };
    }
    return {};
  };
  const request = vi.fn(respond);
  const { gateway, publish } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  configs.push(runtimeConfig);
  await runtimeConfig.ensureLoaded();
  const navigate = vi.fn();
  const page = document.createElement("openclaw-meeting-capture-settings") as CaptureElement;
  page.context = {
    gateway,
    runtimeConfig,
    navigate,
    basePath: "",
  } as unknown as ApplicationContext;
  page.mutationDisabled = options.disabled ?? false;
  document.body.append(page);
  await vi.waitFor(() =>
    expect(page.textContent).toContain(
      options.failStatus ? "Capture health is unknown" : "Not active",
    ),
  );
  return { page, runtimeConfig, request, respond, original, publish, navigate };
}

function click(page: Element, label: string) {
  const element = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label ||
      item.querySelector(".settings-row__title")?.textContent?.trim() === label,
  );
  if (!element) {
    throw new Error(`Missing button: ${label}`);
  }
  element.click();
  return element;
}

function input(page: Element, name: string, value: string) {
  const control = page.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  for (const config of configs.splice(0)) {
    config.dispose();
  }
  vi.restoreAllMocks();
});

describe("curated meeting capture", () => {
  it.each<{
    field: string;
    value: string;
    health: string;
    openDuringRefresh?: boolean;
    reselect?: boolean;
  }>([
    { field: "guildId", value: "", health: "pending" },
    { field: "channelId", value: "   ", health: "error" },
    { field: "accountId", value: "", health: "missing provider" },
    { field: "meetingUrl", value: "   ", health: "missing setup" },
    { field: "guildId", value: "   ", health: "empty setup" },
    { field: "channelId", value: "", health: "pending", openDuringRefresh: true },
    { field: "guildId", value: "   ", health: "pending", openDuringRefresh: true },
    { field: "accountId", value: "   ", health: "error", reselect: true },
  ])(
    "retains $field validation through $health health (open during refresh: $openDuringRefresh, reselect: $reselect)",
    async ({ field, value, health, openDuringRefresh, reselect }) => {
      const { page, runtimeConfig, request, original } = await mount({
        providers: requiredProviders,
      });
      const pending = createDeferred<TranscriptsStatusResult>();
      request.mockImplementationOnce(() => pending.promise);
      const beginRefresh = async () => {
        const refresh = click(page, "Refresh");
        await vi.waitFor(() => expect(refresh.disabled).toBe(true));
        return refresh;
      };
      const startedRefresh = openDuringRefresh ? await beginRefresh() : undefined;
      click(page, "Edit source 1");
      await page.updateComplete;
      const control = page.querySelector<HTMLInputElement>(`input[name="${field}"]`)!;
      const fields = [...page.querySelectorAll("input")].map((item) => item.name);
      const refresh = startedRefresh ?? (await beginRefresh());
      try {
        if (health === "error") {
          pending.reject(new Error("Archive unavailable"));
        } else if (health !== "pending") {
          pending.resolve({
            ...meetingStatus,
            providers:
              health === "missing provider"
                ? []
                : meetingStatus.providers.map((provider) => ({
                    ...provider,
                    autoStart: health === "empty setup" ? {} : undefined,
                  })),
          });
        }
        if (health !== "pending") {
          await vi.waitFor(() => expect(refresh.disabled).toBe(false));
        }
        expect(page.querySelector<HTMLSelectElement>('select[name="providerId"]')?.value).toBe(
          original.providerId,
        );
        if (reselect) {
          page.querySelector('select[name="providerId"]')!.dispatchEvent(new Event("change"));
          await page.updateComplete;
        }
        const patch = vi.spyOn(runtimeConfig, "patchForm");
        input(page, field, value);
        click(page, "Save source");
        await page.updateComplete;
        expect(patch).not.toHaveBeenCalled();
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);
        expect(page.querySelector(`input[name="${field}"]`)).toBe(control);
        expect(control.required).toBe(true);
        expect([...page.querySelectorAll("input")].map((item) => item.name)).toEqual(fields);
        input(page, field, String(original[field]));
        input(page, "title", "Future title");
        expect(page.querySelector<HTMLSelectElement>('select[name="providerId"]')?.value).toBe(
          original.providerId,
        );
        click(page, "Save source");
        await page.updateComplete;
        expect(patch).toHaveBeenCalledOnce();
        await runtimeConfig.save();
        const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
        expect(write?.baseHash).toBe("one");
        expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
          { ...original, title: "Future title" },
        ]);
      } finally {
        pending.resolve(meetingStatus);
      }
    },
  );

  it.each(["client", "epoch"])(
    "does not seed an editor from another %s's retained health",
    async (change) => {
      const { page, runtimeConfig, request, respond, publish, original } = await mount({
        providers: requiredProviders,
      });
      const previous = createDeferred<TranscriptsStatusResult>();
      request.mockImplementationOnce(() => previous.promise);
      const refresh = click(page, "Refresh");
      await vi.waitFor(() => expect(refresh.disabled).toBe(true));
      const current = createDeferred<TranscriptsStatusResult>();
      const currentRequest = vi.fn(
        (method: string, params?: { raw?: string; baseHash?: string }) =>
          method === "transcripts.status" ? current.promise : respond(method, params),
      );
      if (change === "client") {
        publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
      } else {
        request.mockImplementation(currentRequest);
        publish(true);
      }
      await vi.waitFor(() =>
        expect(currentRequest.mock.calls.some(([method]) => method === "transcripts.status")).toBe(
          true,
        ),
      );
      await vi.waitFor(() =>
        expect(
          page.querySelector<HTMLButtonElement>('button[aria-label="Edit source 1"]')?.disabled,
        ).toBe(false),
      );
      try {
        click(page, "Edit source 1");
        await page.updateComplete;
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        input(page, "title", "Keep this draft");
        const statusCalls = currentRequest.mock.calls.filter(
          ([method]) => method === "transcripts.status",
        ).length;
        publish(true, page.context.gateway.snapshot.client!);
        await vi.waitFor(() =>
          expect(
            currentRequest.mock.calls.filter(([method]) => method === "transcripts.status"),
          ).toHaveLength(statusCalls + 1),
        );
        expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
          "Keep this draft",
        );
        current.resolve({ ...meetingStatus, providers: [] });
        await vi.waitFor(() => expect(refresh.disabled).toBe(false));
        previous.resolve({ ...meetingStatus, providers: requiredProviders });
        await previous.promise;
        await page.updateComplete;
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
          "Keep this draft",
        );
        click(page, "Save source");
        await runtimeConfig.save();
        const write = currentRequest.mock.calls.find(([method]) => method === "config.set")?.[1];
        expect(write?.baseHash).toBe("one");
        expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
          { ...original, title: "Keep this draft" },
        ]);
      } finally {
        current.resolve({ ...meetingStatus, providers: [] });
        previous.resolve(meetingStatus);
      }
    },
  );

  it("retains requirements learned after opening an editor without metadata", async () => {
    const { page, runtimeConfig, request, original } = await mount({
      source: { providerId: "test-voice", title: "Original", providerOptions: { keep: true } },
      providers: [],
    });
    click(page, "Edit source 1");
    await page.updateComplete;
    expect(page.querySelector('input[name="guildId"]')).toBeNull();
    input(page, "title", "Unsaved title");
    request.mockResolvedValueOnce({ ...meetingStatus, providers: requiredProviders });
    click(page, "Refresh");
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLInputElement>('input[name="guildId"]')?.required).toBe(true),
    );
    request.mockRejectedValueOnce(new Error("Archive unavailable"));
    click(page, "Refresh");
    await vi.waitFor(() => expect(page.textContent).toContain("Capture health is unknown"));
    const locators = {
      accountId: "team",
      guildId: "guild",
      channelId: "room",
      meetingUrl: "https://example.test/new",
    };
    for (const [field, value] of Object.entries(locators)) {
      input(page, field, value);
    }
    input(page, "channelId", "   ");
    expect(page.querySelector("form")!.checkValidity()).toBe(true);
    const patch = vi.spyOn(runtimeConfig, "patchForm");
    click(page, "Edit source 1");
    click(page, "Save source");
    await page.updateComplete;
    expect(patch).not.toHaveBeenCalled();
    expect(page.querySelector('form [role="alert"]')?.textContent).toContain("Channel ID");
    expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
      "Unsaved title",
    );
    input(page, "channelId", locators.channelId);
    click(page, "Save source");
    await runtimeConfig.save();
    const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
    expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
      { ...original, ...locators, title: "Unsaved title" },
    ]);
    await page.updateComplete;
    click(page, "Edit source 1");
    await page.updateComplete;
    expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
  });

  it.each([
    { health: "pending", field: "guildId", value: "" },
    { health: "error", field: "channelId", value: "" },
    { health: "error", field: "channelId", value: "   " },
  ])(
    "preserves original provider validation through $health round trips ($field=$value)",
    async ({ health, field, value }) => {
      const other = {
        providerId: "other",
        name: "Other",
        availability: "enabled",
        autoStart: {},
      } as const;
      const { page, runtimeConfig, request, original } = await mount({
        providers: [...requiredProviders, other],
      });
      click(page, "Edit source 1");
      await page.updateComplete;
      const provider = page.querySelector<HTMLSelectElement>('select[name="providerId"]')!;
      provider.value = "other";
      provider.dispatchEvent(new Event("change"));
      await page.updateComplete;
      expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
      const pending = createDeferred<TranscriptsStatusResult>();
      request.mockImplementationOnce(() => pending.promise);
      const refresh = click(page, "Refresh");
      await vi.waitFor(() => expect(refresh.disabled).toBe(true));
      const patch = vi.spyOn(runtimeConfig, "patchForm");
      try {
        if (health === "error") {
          pending.reject(new Error("Archive unavailable"));
          await vi.waitFor(() => expect(refresh.disabled).toBe(false));
          expect(page.textContent).toContain("Capture health is unknown");
        }
        page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
        expect(patch).not.toHaveBeenCalled();
        provider.value = "test-voice";
        provider.dispatchEvent(new Event("change"));
        await page.updateComplete;
        input(page, field, value);
        click(page, "Save source");
        expect(patch).not.toHaveBeenCalled();
        expect(page.querySelector<HTMLInputElement>(`input[name="${field}"]`)?.required).toBe(true);
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);
        if (health === "error") {
          input(page, field, String(original[field]));
          input(page, "title", "Future title after return");
          click(page, "Save source");
          expect(patch).toHaveBeenCalledOnce();
          await runtimeConfig.save();
          const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
          expect(write?.baseHash).toBe("one");
          expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
            { ...original, title: "Future title after return" },
          ]);
          return;
        }
        provider.value = "other";
        provider.dispatchEvent(new Event("change"));
        await page.updateComplete;
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        pending.resolve({ ...meetingStatus, providers: [] });
        await vi.waitFor(() => expect(refresh.disabled).toBe(false));
        click(page, "Cancel");
        await page.updateComplete;
        click(page, "Edit source 1");
        await page.updateComplete;
        // A new editor with unknown rules must not inherit the prior selection's rules.
        expect([...page.querySelectorAll("input")].some((item) => item.required)).toBe(false);
        expect(page.querySelector<HTMLInputElement>('input[name="guildId"]')?.value).toBe("guild");
        input(page, "title", "Still editable");
        click(page, "Save source");
        expect(patch).toHaveBeenCalledOnce();
      } finally {
        pending.resolve(meetingStatus);
      }
    },
  );

  it.each(["new", "existing"])(
    "rejects whitespace-only required locators in a %s source and allows correction",
    async (kind) => {
      const { page, runtimeConfig, original, request } = await mount();
      const patch = vi.spyOn(runtimeConfig, "patchForm");
      click(page, kind === "new" ? "Add source" : "Edit source 1");
      await page.updateComplete;
      if (kind === "new") {
        const select = page.querySelector<HTMLSelectElement>('select[name="providerId"]')!;
        select.value = "test-voice";
        select.dispatchEvent(new Event("change"));
        await page.updateComplete;
      }
      input(page, "guildId", "   ");
      input(page, "channelId", " valid-channel ");
      input(page, "accountId", "   ");
      expect(page.querySelector("form")!.checkValidity()).toBe(true);
      click(page, "Save source");
      await page.updateComplete;
      expect(patch).not.toHaveBeenCalled();
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Guild ID");
      expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);

      input(page, "guildId", " valid-guild ");
      click(page, "Save source");
      await page.updateComplete;
      expect(patch).toHaveBeenCalledOnce();
      expect(page.querySelector("form")).toBeNull();
      const expected = {
        ...(kind === "new" ? {} : original),
        providerId: "test-voice",
        guildId: "valid-guild",
        channelId: "valid-channel",
      };
      delete (expected as Record<string, unknown>).accountId;
      await runtimeConfig.save();
      const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
      expect(write?.baseHash).toBe("one");
      expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual(
        kind === "new" ? [original, expected] : [expected],
      );
    },
  );

  it("explains a session ID conflict without hiding the configured ID or changing the draft", async () => {
    const { page, runtimeConfig, original } = await mount({ startDiagnostic: "id-conflict" });
    expect(page.textContent).toContain("This session ID conflicts with an existing capture");
    click(page, "Edit source 1");
    await page.updateComplete;
    expect(page.textContent).toContain("Used for future captures");
    expect(page.querySelector<HTMLInputElement>('input[name="sessionId"]')?.value).toBe(
      original.sessionId,
    );
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("disables an occupancy source's ignored custom ID while preserving it through a title edit", async () => {
    const source = {
      providerId: "test-voice",
      title: "Occupied room",
      guildId: "guild",
      channelId: "room",
      whenOccupied: true,
      sessionId: "saved-custom-id",
    };
    const { page, runtimeConfig, request } = await mount({ source });
    click(page, "Edit source 1");
    await page.updateComplete;
    const id = page.querySelector<HTMLInputElement>('input[name="sessionId"]')!;
    expect(id.disabled).toBe(true);
    expect(id.value).toBe(source.sessionId);
    expect(page.textContent).toContain("Occupancy mode chooses session IDs automatically");
    input(page, "title", "Future occupied room");
    click(page, "Save source");
    await runtimeConfig.save();
    const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
    expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
      { ...source, title: "Future occupied room" },
    ]);
  });

  it("does not save another entry's dirty locator when switching directly between equal sources", async () => {
    const { page, runtimeConfig, original } = await mount();
    const second = { ...original, title: "Second source" };
    runtimeConfig.patchForm(["transcripts", "autoStart"], [original, second]);
    await page.updateComplete;
    click(page, "Edit source 1");
    await page.updateComplete;
    const account = page.querySelector<HTMLInputElement>('input[name="accountId"]')!;
    account.value = "unsaved-account";
    account.dispatchEvent(new Event("input"));
    click(page, "Edit source 2");
    await page.updateComplete;
    page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: { autoStart: [original, second] },
    });
  });

  it("edits through the shared draft without dropping locators or a custom session ID", async () => {
    const { page, runtimeConfig, original, request, navigate } = await mount();
    click(page, "Edit source 1");
    await page.updateComplete;
    input(page, "title", "Updated title");
    page
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: { autoStart: [{ ...original, title: "Updated title" }] },
      messages: { ackReaction: "ok" },
    });
    expect(original.title).toBe("Original title");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    await runtimeConfig.save();
    expect(request).toHaveBeenCalledWith(
      "config.set",
      expect.objectContaining({ baseHash: "one", raw: expect.stringContaining("custom-session") }),
    );
    click(page, "Transcript library");
    expect(navigate).toHaveBeenCalledWith("meetings");
  });

  it.each([
    { name: "padded identity and browser-sanitized URL", providerId: "test-voice", refresh: false },
    {
      name: "padded provider after metadata disappears",
      providerId: " test-voice ",
      refresh: true,
    },
    { name: "unknown provider with omitted locators", providerId: " unknown ", refresh: false },
  ])("preserves $name on re-entry and save", async ({ providerId, refresh }) => {
    const source = {
      providerId,
      title: "Original title",
      sessionId: " daily ",
      ...(providerId.includes("unknown")
        ? {}
        : {
            accountId: " team ",
            guildId: " guild ",
            channelId: " room ",
            meetingUrl: " https://example.test/meeting?invitation=synthetic#fragment ",
          }),
      providerOptions: { untouched: true },
    };
    const { page, runtimeConfig, request } = await mount({ source });
    click(page, "Edit source 1");
    await page.updateComplete;
    const url = page.querySelector<HTMLInputElement>('input[name="meetingUrl"]');
    if (source.meetingUrl) {
      expect(url?.value).toBe(source.meetingUrl.trim());
      expect(new FormData(page.querySelector("form")!).get("meetingUrl")).not.toBe(
        source.meetingUrl,
      );
    } else {
      expect(url).toBeNull();
      expect(page.querySelector('input[name="accountId"]')).toBeNull();
    }
    input(page, "title", " Future title ");
    if (refresh) {
      request.mockResolvedValueOnce({ ...meetingStatus, providers: [] });
      click(page, "Refresh");
      await vi.waitFor(() =>
        expect(
          page.querySelector<HTMLSelectElement>('select[name="providerId"]')?.options,
        ).toHaveLength(2),
      );
    }
    click(page, "Edit source 1");
    if (refresh) {
      await page.updateComplete;
    }
    expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
      " Future title ",
    );
    click(page, "Save source");
    const expected = {
      transcripts: { enabled: true, autoStart: [{ ...source, title: "Future title" }] },
      messages: { ackReaction: "ok" },
    };
    expect(runtimeConfig.state.configForm).toEqual(expected);
    expect(source.title).toBe("Original title");
    await runtimeConfig.save();
    const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
    expect(write?.baseHash).toBe("one");
    expect(JSON.parse(write!.raw!)).toEqual(expected);
  });

  it("normalizes edited values and explicitly clears optional fields without rewriting untouched values", async () => {
    const source = {
      providerId: "test-voice",
      title: "Original title",
      sessionId: " daily ",
      accountId: " team ",
      guildId: " guild ",
      channelId: " room ",
      meetingUrl: " https://example.test/old?invitation=synthetic ",
    };
    const { page, runtimeConfig } = await mount({ source });
    click(page, "Edit source 1");
    await page.updateComplete;
    input(page, "accountId", " new-account ");
    input(page, "meetingUrl", " https://example.test/new?invitation=updated ");
    input(page, "sessionId", "");
    input(page, "title", " ");
    click(page, "Edit source 1");
    click(page, "Save source");
    expect(runtimeConfig.state.configForm).toEqual({
      transcripts: {
        enabled: true,
        autoStart: [
          {
            providerId: "test-voice",
            accountId: "new-account",
            guildId: " guild ",
            channelId: " room ",
            meetingUrl: "https://example.test/new?invitation=updated",
          },
        ],
      },
      messages: { ackReaction: "ok" },
    });
  });

  it("requires Cancel and reopen to edit a replaced source, including after re-entry", async () => {
    const { page, runtimeConfig, original, request } = await mount();
    click(page, "Edit source 1");
    await page.updateComplete;
    input(page, "title", "Stale edit");
    const replacement = { ...original, sessionId: "replacement" };
    runtimeConfig.patchForm(["transcripts", "autoStart"], [replacement]);
    await page.updateComplete;
    page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await page.updateComplete;
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: { autoStart: [replacement] },
    });
    const error = "Cancel and reopen it to use the current draft.";
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(error);
    click(page, "Edit source 1");
    await page.updateComplete;
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(error);
    expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Stale edit");
    click(page, "Save source");
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: { autoStart: [replacement] },
    });
    click(page, "Cancel");
    await page.updateComplete;
    click(page, "Edit source 1");
    await page.updateComplete;
    expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(original.title);
    expect(page.querySelector<HTMLInputElement>('input[name="sessionId"]')?.value).toBe(
      "replacement",
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
    input(page, "title", "Current edit");
    click(page, "Save source");
    await runtimeConfig.save();
    const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
    expect(write?.baseHash).toBe("one");
    expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
      { ...replacement, title: "Current edit" },
    ]);
  });

  it.each([false, true])(
    "validates a genuine provider change against current metadata (unavailable=%s)",
    async (unavailable) => {
      const { page, runtimeConfig, original, request } = await mount({
        providers: [
          ...meetingStatus.providers,
          { providerId: "other", name: "Other", availability: "enabled", autoStart: {} },
        ],
      });
      click(page, "Edit source 1");
      await page.updateComplete;
      const provider = page.querySelector<HTMLSelectElement>('select[name="providerId"]')!;
      provider.value = "other";
      provider.dispatchEvent(new Event("change"));
      await page.updateComplete;
      if (unavailable) {
        request.mockResolvedValueOnce({ ...meetingStatus, providers: [] });
        click(page, "Refresh");
        await vi.waitFor(() =>
          expect([...provider.options].map((option) => option.value)).toEqual([
            "",
            "test-voice",
            "other",
          ]),
        );
        expect(provider.value).toBe("other");
      }
      page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(runtimeConfig.state.configForm).toMatchObject({
        transcripts: {
          autoStart: [{ ...original, providerId: unavailable ? original.providerId : "other" }],
        },
      });
      expect(runtimeConfig.state.configFormDirty).toBe(!unavailable);
    },
  );

  it("rejects an open editor submission after admin access is revoked", async () => {
    const { page, runtimeConfig, original, publish } = await mount();
    click(page, "Edit source 1");
    await page.updateComplete;
    input(page, "title", "Unauthorized edit");
    const snapshot = page.context.gateway.snapshot;
    publish(true, snapshot.client!, {
      ...snapshot.hello!,
      auth: { ...snapshot.hello!.auth, scopes: ["operator.read"] },
    });
    await page.updateComplete;
    page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: { autoStart: [original] },
    });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("adds a source and removes an entry without removing stored transcripts or sibling config", async () => {
    const { page, runtimeConfig, request } = await mount({
      providers: meetingStatus.providers.map(({ canStart: _canStart, ...provider }) => provider),
    });
    click(page, "Add source");
    await page.updateComplete;
    page.querySelector<HTMLSelectElement>('select[name="providerId"]')!.value = "test-voice";
    page
      .querySelector<HTMLSelectElement>('select[name="providerId"]')!
      .dispatchEvent(new Event("change"));
    await page.updateComplete;
    const guild = page.querySelector<HTMLInputElement>('input[name="guildId"]')!;
    expect(guild.required).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[name="accountId"]')!.required).toBe(false);
    expect(page.querySelector('input[name="meetingUrl"]')).toBeNull();
    expect(page.querySelector("form")!.checkValidity()).toBe(false);
    input(page, "guildId", " second-guild ");
    input(page, "channelId", " second-room ");
    click(page, "Add source");
    await page.updateComplete;
    expect(page.querySelector<HTMLSelectElement>('select[name="providerId"]')?.value).toBe(
      "test-voice",
    );
    expect(page.querySelector<HTMLInputElement>('input[name="guildId"]')?.value).toBe(
      " second-guild ",
    );
    click(page, "Save source");
    await page.updateComplete;
    click(page, "Remove source 1");
    expect(runtimeConfig.state.configForm).toMatchObject({
      transcripts: {
        autoStart: [
          { providerId: "test-voice", guildId: "second-guild", channelId: "second-room" },
        ],
      },
      messages: { ackReaction: "ok" },
    });
    expect(
      request.mock.calls.some(([method]) => method.includes("delete") || method.includes("stop")),
    ).toBe(false);
    await runtimeConfig.save();
    const write = request.mock.calls.find(([method]) => method === "config.set")?.[1];
    expect(write?.baseHash).toBe("one");
    expect(JSON.parse(write!.raw!).transcripts.autoStart).toEqual([
      { providerId: "test-voice", guildId: "second-guild", channelId: "second-room" },
    ]);
    await page.updateComplete;
    click(page, "Add source");
    await page.updateComplete;
    expect(page.querySelector<HTMLSelectElement>('select[name="providerId"]')?.value).toBe("");
    input(page, "title", "Discard this draft");
    click(page, "Cancel");
    await page.updateComplete;
    click(page, "Add source");
    await page.updateComplete;
    expect(page.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("");
    expect(page.querySelector('input[name="guildId"]')).toBeNull();
  });

  it("offers enabled manifest setup before runtime loads, but rejects observed start contradictions", async () => {
    const { page } = await mount({
      providers: [
        ...meetingStatus.providers,
        {
          providerId: "attach-only",
          name: "Attach only",
          availability: "enabled",
          canStart: true,
          sourceKinds: ["live-audio"],
        },
        {
          providerId: "metadata-only",
          name: "Metadata only",
          availability: "enabled",
          autoStart: {},
        },
        {
          providerId: "disabled",
          name: "Disabled",
          availability: "disabled",
          canStart: true,
          autoStart: {},
        },
        {
          providerId: "unknown",
          name: "Unknown",
          availability: "unknown",
          canStart: true,
          autoStart: {},
        },
        {
          providerId: "cannot-start",
          name: "Cannot start",
          availability: "enabled",
          canStart: false,
          autoStart: {},
        },
      ],
    });
    click(page, "Add source");
    await page.updateComplete;
    expect(
      [...page.querySelectorAll<HTMLOptionElement>('select[name="providerId"] option')].map(
        (option) => option.value,
      ),
    ).toEqual(["", "metadata-only", "test-voice"]);
  });

  it.each(["disabled", "unknown", "unavailable"] as const)(
    "keeps existing %s sources editable with unavailable guidance",
    async (availability) => {
      const { page, runtimeConfig, original } = await mount({
        providers: [{ providerId: "test-voice", name: "Test voice", availability }],
      });
      const add = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Add source",
      )!;
      expect(add.disabled).toBe(true);
      click(page, "Edit source 1");
      await page.updateComplete;
      expect(page.textContent).toContain("Auto-start setup is unavailable");
      input(page, "title", "Still editable");
      page
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(runtimeConfig.state.configForm).toMatchObject({
        transcripts: { autoStart: [{ ...original, title: "Still editable" }] },
      });
    },
  );

  it("keeps health unknown after read failure and disables mutations under the parent's permission gate", async () => {
    const { page, runtimeConfig } = await mount({ disabled: true, failStatus: true });
    expect(page.textContent).toContain("Unknown");
    expect(page.textContent).not.toContain("Not active");
    expect(
      [
        ...page.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="Edit source"], button[aria-label^="Remove source"]',
        ),
      ].every((button) => button.disabled),
    ).toBe(true);
    expect(page.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("keeps source form edits intact through a health refresh", async () => {
    const { page } = await mount();
    click(page, "Edit source 1");
    await page.updateComplete;
    const title = page.querySelector<HTMLInputElement>('input[name="title"]')!;
    title.value = "Not yet submitted";
    click(page, "Refresh");
    await vi.waitFor(() => expect(page.textContent).toContain("Not active"));
    await page.updateComplete;
    expect(title.value).toBe("Not yet submitted");
  });

  it("retains newly entered locators while a health refresh is pending", async () => {
    const { page, request, runtimeConfig } = await mount();
    click(page, "Add source");
    await page.updateComplete;
    const select = page.querySelector<HTMLSelectElement>('select[name="providerId"]')!;
    select.value = "test-voice";
    select.dispatchEvent(new Event("change"));
    await page.updateComplete;
    const account = page.querySelector<HTMLInputElement>('input[name="accountId"]')!;
    account.value = "new-account";
    account.dispatchEvent(new Event("input"));
    input(page, "guildId", "new-guild");
    input(page, "channelId", "new-channel");
    const { promise: pending, resolve: finish } = createDeferred();
    request.mockImplementationOnce(async () => {
      await pending;
      return meetingStatus;
    });
    click(page, "Refresh");
    await vi.waitFor(() => expect(page.textContent).toContain("Loading"));
    expect(page.querySelector<HTMLInputElement>('input[name="accountId"]')?.value).toBe(
      "new-account",
    );
    page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    finish();
    await vi.waitFor(() => expect(page.textContent).toContain("Not active"));
    expect(page.querySelector<HTMLInputElement>('input[name="accountId"]')?.value).toBe(
      "new-account",
    );
    click(page, "Save source");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
  });

  it("does not overwrite an authoritative raw config draft with an old source array", async () => {
    const { page, runtimeConfig } = await mount();
    click(page, "Edit source 1");
    await page.updateComplete;
    input(page, "title", "Stale title");
    runtimeConfig.setRaw('{ "transcripts": { "autoStart": [{ "providerId": "other" }] } }');
    await page.updateComplete;
    expect(page.textContent).toContain("Save or discard the pending raw config draft");
    expect(
      page.querySelector<HTMLButtonElement>('button[aria-label="Remove source 1"]')?.disabled,
    ).toBe(true);
    page.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(runtimeConfig.state.configRaw).toContain('"providerId": "other"');
  });
});
