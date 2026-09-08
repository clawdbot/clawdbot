// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import {
  createGatewayProfile,
  GatewayRegistryPersistenceError,
  loadGatewayRegistry,
  loadGatewayRegistryForGateway,
  removeGatewayProfile,
  renameGatewayProfile,
  selectGatewayProfile,
  upsertGatewayProfile,
  type GatewayProfile,
} from "./gateway-registry.ts";
import { loadSettings, saveSettings } from "./settings.ts";

const TEST_GATEWAY_REGISTRY_STORAGE_KEY = "openclaw.control.gateway-registry.v1";
const EXPECTED_GATEWAY_CAPACITY = 20;

describe("gateway registry", () => {
  installSettingsStorageLifecycle();

  it("normalizes URLs and keeps query-scoped gateways distinct", () => {
    setTestLocation({ protocol: "https:", host: "control.example", pathname: "/" });

    expect(createGatewayProfile({ url: "wss://team.example/openclaw/#ignored" })?.url).toBe(
      "wss://team.example/openclaw",
    );
    expect(createGatewayProfile({ url: "https://team.example/openclaw" })).toBeNull();
    expect(createGatewayProfile({ url: "wss://team.example?account=personal" })?.id).not.toBe(
      createGatewayProfile({ url: "wss://team.example?account=team" })?.id,
    );
  });

  it("adds, selects, and removes saved gateways without persisting credentials", () => {
    setTestLocation({ protocol: "https:", host: "control.example", pathname: "/" });
    const personal = createGatewayProfile({
      name: "Personal Claw",
      url: "wss://personal.example/",
    });
    const team = createGatewayProfile({ name: "Team Claw", url: "wss://team.example/" });
    expect(personal).not.toBeNull();
    expect(team).not.toBeNull();
    if (!personal || !team) {
      throw new Error("test fixtures must produce gateway profiles");
    }

    upsertGatewayProfile(personal, { select: true });
    upsertGatewayProfile(team);
    expect(loadGatewayRegistry()).toMatchObject({
      gateways: [personal, team],
      activeGatewayId: personal.id,
    });

    selectGatewayProfile(team.id);
    expect(loadGatewayRegistry().activeGatewayId).toBe(team.id);

    const persisted = localStorage.getItem(TEST_GATEWAY_REGISTRY_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain("token");
    expect(persisted).not.toContain("password");

    removeGatewayProfile(team.id);
    expect(loadGatewayRegistry()).toMatchObject({
      gateways: [personal],
      activeGatewayId: personal.id,
    });
  });

  it("renames a saved gateway without changing its URL or active selection", () => {
    const team = createGatewayProfile({ name: "Team", url: "wss://team.example/" });
    expect(team).not.toBeNull();
    if (!team) {
      throw new Error("test fixture must produce a gateway profile");
    }
    upsertGatewayProfile(team, { select: true });

    const renamed = renameGatewayProfile(team.id, "  Team Claw MGSC 310  ");

    expect(renamed).toEqual({
      gateways: [{ ...team, name: "Team Claw MGSC 310" }],
      activeGatewayId: team.id,
    });
    expect(loadGatewayRegistry()).toEqual(renamed);
  });

  it("ignores malformed entries and repairs an invalid active selection", () => {
    localStorage.setItem(
      TEST_GATEWAY_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        gateways: [
          { name: "Personal", url: "wss://personal.example/" },
          { name: "Duplicate", url: "wss://personal.example" },
          { name: "Invalid", url: "https://not-a-websocket.example" },
        ],
        activeGatewayId: "missing",
      }),
    );

    const registry = loadGatewayRegistry();
    expect(registry.gateways).toHaveLength(1);
    expect(registry.activeGatewayId).toBe(registry.gateways[0]?.id);
  });

  it("rejects a new profile when the registry is at capacity", () => {
    const profiles = Array.from({ length: EXPECTED_GATEWAY_CAPACITY }, (_, index) =>
      createGatewayProfile({
        name: `Gateway ${index}`,
        url: `wss://gateway-${index}.example/`,
      }),
    );
    if (profiles.some((profile) => profile === null)) {
      throw new Error("test fixtures must produce gateway profiles");
    }
    const savedProfiles = profiles as GatewayProfile[];
    for (const [index, profile] of savedProfiles.entries()) {
      upsertGatewayProfile(profile, { select: index === 0 });
    }
    const before = loadGatewayRegistry();
    const extra = createGatewayProfile({ name: "Overflow", url: "wss://overflow.example/" });
    expect(extra).not.toBeNull();
    if (!extra) {
      throw new Error("test fixture must produce a gateway profile");
    }

    const after = upsertGatewayProfile(extra, { select: true });

    expect(after).toEqual(before);
    expect(after.gateways).toHaveLength(EXPECTED_GATEWAY_CAPACITY);
    expect(after.gateways.some((gateway) => gateway.id === extra.id)).toBe(false);
    expect(loadGatewayRegistry()).toEqual(before);
  });

  it("derives the visible active gateway from the current connection", () => {
    const personal = createGatewayProfile({ name: "Personal", url: "wss://personal.example/" });
    const team = createGatewayProfile({ name: "Team", url: "wss://team.example/" });
    if (!personal || !team) {
      throw new Error("test fixtures must produce gateway profiles");
    }
    upsertGatewayProfile(personal, { select: true });
    upsertGatewayProfile(team);

    expect(loadGatewayRegistryForGateway(team.url).activeGatewayId).toBe(team.id);
    expect(loadGatewayRegistry().activeGatewayId).toBe(personal.id);
  });

  it("surfaces registry persistence failures to callers", () => {
    const profile = createGatewayProfile({ name: "Personal", url: "wss://personal.example/" });
    expect(profile).not.toBeNull();
    if (!profile) {
      throw new Error("test fixture must produce a gateway profile");
    }

    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      expect(() => upsertGatewayProfile(profile)).toThrow(GatewayRegistryPersistenceError);
    } finally {
      setItem.mockRestore();
    }
  });

  it("migrates the legacy selected gateway into the registry on the next settings save", () => {
    setTestLocation({ protocol: "https:", host: "control.example", pathname: "/" });
    const teamUrl = "wss://team.example/openclaw";
    const team = createGatewayProfile({ url: teamUrl });
    if (!team) {
      throw new Error("test fixture must produce a gateway profile");
    }
    localStorage.setItem("openclaw.control.currentGateway.v1:wss://control.example", teamUrl);
    localStorage.setItem(
      `openclaw.control.settings.v1:${teamUrl}`,
      JSON.stringify({ gatewayUrl: teamUrl, theme: "claw" }),
    );

    expect(loadSettings().gatewayUrl).toBe(teamUrl);
    saveSettings(loadSettings());
    expect(loadGatewayRegistry()).toMatchObject({
      activeGatewayId: team.id,
      gateways: [{ url: teamUrl }],
    });
  });

  it("preserves a saved gateway name when its connection settings are saved", () => {
    setTestLocation({ protocol: "https:", host: "control.example", pathname: "/" });
    const team = createGatewayProfile({ name: "Classmates", url: "wss://team.example/" });
    expect(team).not.toBeNull();
    if (!team) {
      throw new Error("test fixture must produce a gateway profile");
    }

    upsertGatewayProfile(team, { select: true });
    saveSettings({ ...loadSettings(), gatewayUrl: team.url });

    expect(loadGatewayRegistry().gateways).toEqual([team]);
  });
});
