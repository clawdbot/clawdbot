import { describe, expect, it, vi } from "vitest";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

describe("Gateway plugin runtime generation", () => {
  it("blocks stale publication during reservation, restores rejected claims, and commits winners", async () => {
    let currentServices: PluginServicesHandle | null = null;
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (services) => {
        currentServices = services;
      },
    });
    const startupClaim = owner.currentClaim();
    const published = vi.fn();

    expect(startupClaim.publish(published)).toBe(true);

    const rejectedReplacement = owner.reserve();
    expect(startupClaim.isCurrent()).toBe(false);
    expect(startupClaim.publish(published)).toBe(false);
    let startupUnblocked = false;
    const startupCanContinue = startupClaim.waitForUnblocked().then(() => {
      startupUnblocked = true;
    });
    await Promise.resolve();
    expect(startupUnblocked).toBe(false);
    rejectedReplacement.reject();
    await startupCanContinue;
    expect(startupClaim.isCurrent()).toBe(true);

    const acceptedReplacement = owner.reserve();
    expect(acceptedReplacement.claim.publish(published)).toBe(false);
    acceptedReplacement.commit();
    expect(owner.currentClaim()).toBe(acceptedReplacement.claim);
    expect(startupClaim.publish(published)).toBe(false);
    expect(acceptedReplacement.claim.publish(published)).toBe(true);
    expect(published).toHaveBeenCalledTimes(2);

    const winningServices: PluginServicesHandle = {
      reload: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    expect(owner.publishServices(startupClaim, winningServices)).toBe(false);
    expect(owner.publishServices(acceptedReplacement.claim, winningServices)).toBe(true);
    expect(owner.currentServices()).toBe(winningServices);
  });

  it("keeps retired claims invalid across rejection until a replacement commits", async () => {
    let currentServices: PluginServicesHandle | null = null;
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (services) => {
        currentServices = services;
      },
    });
    const previous = owner.currentClaim();
    const replacement = owner.reserve();
    const previousUnblocked = previous.waitForUnblocked();
    replacement.retirePrevious();
    replacement.reject();
    await expect(previousUnblocked).resolves.toBe(false);
    const services = { reload: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    expect(owner.publishServices(previous, services)).toBe(false);
    const cancelledRetry = owner.reserve();
    cancelledRetry.reject();
    expect(previous.isCurrent()).toBe(false);
    const committed = owner.reserve();
    committed.commit();
    replacement.retirePrevious();
    expect(committed.claim.isCurrent()).toBe(true);
    expect(owner.publishServices(committed.claim, services)).toBe(true);
    expect(owner.currentServices()).toBe(services);
    expect(previous.isCurrent()).toBe(false);
  });

  it.each([
    { successor: "rejects", survives: true },
    { successor: "commits", survives: false },
  ])(
    "settles a pending successor that $successor before deciding discovery and service ownership",
    async ({ survives }) => {
      let currentServices: PluginServicesHandle | null = null;
      const owner = createGatewayPluginRuntimeGeneration({
        getServices: () => currentServices,
        setServices: (services) => {
          currentServices = services;
        },
      });
      const committed = owner.reserve();
      committed.commit();
      const pendingSuccessor = owner.reserve();
      const discoveryStop = vi.fn();
      const services: PluginServicesHandle = {
        reload: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      let settled = false;
      const publication = committed.claim.waitForUnblocked().then((isCurrent) => {
        settled = true;
        if (isCurrent) {
          owner.publishServices(committed.claim, services);
        } else {
          discoveryStop();
        }
        return isCurrent;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      if (survives) {
        pendingSuccessor.reject();
      } else {
        pendingSuccessor.commit();
      }

      await expect(publication).resolves.toBe(survives);
      expect(owner.currentServices()).toBe(survives ? services : null);
      expect(discoveryStop).toHaveBeenCalledTimes(survives ? 0 : 1);
    },
  );
});
