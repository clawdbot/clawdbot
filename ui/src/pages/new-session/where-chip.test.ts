import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { readDraftEnvironments } from "./discovery.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

describe("Where chip state", () => {
  const nodes = [
    {
      nodeId: "macbook",
      displayName: "MacBook",
      connected: true,
      canExec: true,
      canBrowse: true,
    },
    {
      nodeId: "offline",
      displayName: "Offline",
      connected: false,
      canExec: true,
      canBrowse: true,
    },
  ];

  it.each([
    {
      name: "keeps Local visible without alternate destinations",
      params: {
        execNodes: [],
        environments: [],
        cloudProfiles: [],
        execNode: "",
        cloudProfileId: "",
      },
      expected: { kind: "local", label: "Local", nodes: [] },
    },
    {
      name: "uses the selected eligible node name",
      params: {
        execNodes: nodes,
        environments: readDraftEnvironments([{ id: "node:macbook", type: "node" }]),
        cloudProfiles: [],
        execNode: "macbook",
        cloudProfileId: "",
      },
      expected: { kind: "node", label: "MacBook", nodes: ["macbook"] },
    },
    {
      name: "treats a cloud profile as a place",
      params: {
        execNodes: nodes,
        environments: [],
        cloudProfiles: [{ id: "build-fleet", providerId: "crabbox" }],
        execNode: "",
        cloudProfileId: "build-fleet",
      },
      expected: { kind: "cloud", label: "build-fleet", nodes: ["macbook"] },
    },
  ])("$name", ({ params, expected }) => {
    const state = resolveWhereChip(params);
    expect({
      kind: state.kind,
      label: state.label,
      nodes: state.deviceNodes.map((node) => node.nodeId),
    }).toEqual(expected);
  });

  it("marks the catalog default and surfaces only a non-default machine in the chip", () => {
    const cloudProfiles = [
      {
        id: "build-fleet",
        providerId: "crabbox",
        machines: [
          { id: "standard", label: "Standard", description: "Balanced capacity", default: true },
          { id: "fast", label: "Fast", description: "More compute" },
        ],
      },
    ];
    const selected = vi.fn();
    const defaultState = resolveWhereChip({
      execNodes: [],
      environments: [],
      cloudProfiles,
      execNode: "",
      cloudProfileId: "build-fleet",
      machineClass: "",
    });
    expect(defaultState.label).toBe("build-fleet");
    expect(defaultState.selectedMachineId).toBe("standard");

    const container = document.createElement("div");
    render(
      renderWhereChip({
        state: defaultState,
        gatewayName: "",
        cloudProfileId: "build-fleet",
        machineClass: "",
        execNode: "",
        worktreeAvailable: true,
        submitting: false,
        pendingCloud: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: true,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectExecNode: () => undefined,
        onSelectCloudProfile: () => undefined,
        onSelectCloudMachine: selected,
        onConnectMachine: () => undefined,
      }),
      container,
    );
    expect(container.querySelector('[data-value="machine:standard"]')?.textContent).toContain(
      "Default",
    );
    container.querySelector<HTMLButtonElement>('[data-value="machine:fast"]')?.click();
    expect(selected).toHaveBeenCalledWith("fast");

    const overrideState = resolveWhereChip({
      execNodes: [],
      environments: [],
      cloudProfiles,
      execNode: "",
      cloudProfileId: "build-fleet",
      machineClass: "fast",
    });
    expect(overrideState.label).toBe("build-fleet · Fast");

    const recoveredState = resolveWhereChip({
      execNodes: [],
      environments: [],
      cloudProfiles: [{ id: "build-fleet", providerId: "crabbox" }],
      execNode: "",
      cloudProfileId: "build-fleet",
      machineClass: "fast",
    });
    expect(recoveredState.label).toBe("build-fleet · fast");
  });

  it("shows bounded environment facts without default-state or infrastructure clutter", () => {
    const state = resolveWhereChip({
      execNodes: [
        ...nodes,
        {
          nodeId: "iphone",
          displayName: "iPhone",
          connected: true,
          canExec: true,
          canBrowse: false,
        },
      ],
      environments: readDraftEnvironments([
        {
          id: "gateway",
          type: "local",
          platform: "linux",
          sessionHost: true,
          trust: "persistent",
          capabilities: ["sessions", "tools", "workspace"],
        },
        {
          id: "node:macbook",
          type: "node",
          platform: "darwin",
          trust: "persistent",
          capabilities: [
            "camera.snap",
            "screen.record",
            "voice",
            "microphone.capture",
            "system.run",
            "fs.listDir",
            "custom.unknown",
          ],
        },
        {
          id: "node:iphone",
          type: "node",
          platform: "iOS 26.4",
          capabilities: ["location.get", "talk.ptt.start", "canvas.navigate"],
        },
      ]),
      cloudProfiles: [
        { id: "aws", providerId: "crabbox", trust: "disposable" },
        { id: "shared", providerId: "static-ssh", trust: "persistent" },
        { id: "plain", providerId: "opaque-provider" },
      ],
      execNode: "",
      cloudProfileId: "",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        cloudProfileId: "",
        execNode: "",
        worktreeAvailable: true,
        submitting: false,
        pendingCloud: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: true,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectExecNode: () => undefined,
        onSelectCloudProfile: () => undefined,
        onConnectMachine: () => undefined,
      }),
      container,
    );

    const facts = (value: string) =>
      [...container.querySelectorAll(`[data-value="${value}"] .new-session-page__menu-fact`)].map(
        (element) => element.textContent?.trim(),
      );
    expect(facts("node:macbook")).toEqual(["macOS", "Camera", "Screen capture", "Voice"]);
    expect(facts("node:iphone")).toEqual(["iOS 26.4", "Location", "Talk", "Canvas"]);
    expect(facts("cloud:aws")).toEqual(["Disposable"]);
    expect(facts("cloud:shared")).toEqual(["Persistent"]);
    expect(facts("cloud:plain")).toEqual([]);
    expect(facts("gateway")).toEqual([]);
    const visibleCopy = container.textContent?.toLowerCase() ?? "";
    for (const clutter of [
      "available",
      "online",
      "session host",
      "crabbox",
      "static-ssh",
      "opaque-provider",
      "system.run",
      "fs.listdir",
      "custom.unknown",
    ]) {
      expect(visibleCopy).not.toContain(clutter);
    }
  });

  it("shows offline execution devices as disabled exceptional rows", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const state = resolveWhereChip({
        execNodes: [
          {
            nodeId: "online",
            displayName: "Online",
            connected: true,
            canExec: true,
            canBrowse: true,
          },
          {
            nodeId: "never",
            displayName: "Never",
            connected: false,
            canExec: true,
            canBrowse: false,
          },
          {
            nodeId: "lost",
            displayName: "Lost",
            connected: false,
            canExec: true,
            canBrowse: false,
          },
          {
            nodeId: "legacy",
            displayName: "Legacy",
            connected: false,
            canExec: true,
            canBrowse: false,
          },
          {
            nodeId: "camera",
            displayName: "Camera only",
            connected: false,
            canExec: false,
            canBrowse: false,
          },
          {
            nodeId: "outdated",
            displayName: "Outdated",
            connected: true,
            canExec: true,
            canBrowse: true,
          },
        ],
        environments: readDraftEnvironments([
          { id: "node:online", type: "node", platform: "darwin" },
          {
            id: "node:never",
            type: "node",
            platform: "linux",
            lastSeenAtMs: 2_000,
            lastSeenReason: "device-token-auth",
          },
          {
            id: "node:lost",
            type: "node",
            platform: "linux",
            lastConnectedAtMs: 1_000,
            lastDisconnectedAtMs: 4_000,
            lastSeenAtMs: 3_000,
          },
          {
            id: "node:legacy",
            type: "node",
            lastConnectedAtMs: 1_000,
            lastSeenAtMs: 5_000,
          },
          { id: "node:camera", type: "node" },
          {
            id: "node:outdated",
            type: "node",
            issues: [
              {
                code: "update-required",
                action: "update-and-reconnect",
                updateCommand: "openclaw update",
                headlessReconnectCommand: "openclaw node restart",
              },
            ],
          },
        ]),
        cloudProfiles: [],
        execNode: "",
        cloudProfileId: "",
      });
      const container = document.createElement("div");
      render(
        renderWhereChip({
          state,
          gatewayName: "",
          cloudProfileId: "",
          execNode: "",
          worktreeAvailable: true,
          submitting: false,
          pendingCloud: false,
          popoverOpen: true,
          popoverHiding: false,
          isAdmin: true,
          onGuardTransition: () => undefined,
          onPopoverShow: () => undefined,
          onPopoverHide: () => undefined,
          onPopoverAfterHide: () => undefined,
          onSelectExecNode: () => undefined,
          onSelectCloudProfile: () => undefined,
          onConnectMachine: () => undefined,
        }),
        container,
      );

      const row = (id: string) =>
        container.querySelector<HTMLButtonElement>(`[data-value="node:${id}"]`);
      const facts = (id: string) =>
        [...(row(id)?.querySelectorAll(".new-session-page__menu-fact") ?? [])].map((entry) =>
          entry.textContent?.trim(),
        );
      expect(row("online")?.disabled).toBe(false);
      expect(facts("online")).toEqual(["macOS"]);
      expect(row("never")?.disabled).toBe(true);
      expect(facts("never")[0]).toBe("Never connected");
      expect(row("lost")?.disabled).toBe(true);
      expect(facts("lost")[0]).toMatch(/^Offline for /);
      expect(row("legacy")?.disabled).toBe(true);
      expect(facts("legacy")[0]).toMatch(/^Last seen /);
      expect(row("outdated")?.disabled).toBe(true);
      expect(facts("outdated")).toEqual([
        "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
      ]);
      expect(row("camera")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});
