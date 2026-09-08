import { expect, test } from "vitest";
import {
  gatewayStartupFixtureSource,
  runGatewayFixtureFork,
} from "./server.fixture-lifetime.test-support.js";

// Each retained failure needs its own fork: a later case must not reset the failed owner.
for (const scenario of [
  { id: "public clean cleanup", missingTls: false, failCleanup: false, requiredJoin: false },
  {
    id: "public required cleanup failure",
    missingTls: false,
    failCleanup: true,
    requiredJoin: true,
  },
  {
    id: "kernel required cleanup failure",
    missingTls: true,
    failCleanup: true,
    requiredJoin: true,
  },
]) {
  test(`startup fixture ownership: ${scenario.id}`, (context) =>
    runGatewayFixtureFork(
      context,
      (repoRoot, root) => gatewayStartupFixtureSource(repoRoot, root, scenario),
      (journal, text) => {
        const retained = scenario.failCleanup;
        const refusal = {
          rejected: retained,
          startupPreserved: retained,
          cleanupPreserved: retained,
        };
        const state = { home: retained, state: retained, selectorsIntact: retained };
        expect(journal, text).toMatchObject({
          combinedFailure: retained,
          nativeStartupMatches: true,
          startupCausePreserved: retained,
          cleanupIdentityPreserved: retained,
          cleanupFaultPreserved: retained,
          nativeCloseCalls: 1,
          nativeCloseStatus: retained ? "rejected" : "fulfilled",
          kernelReturned: !scenario.missingTls,
          listenCalls: scenario.missingTls ? 0 : 1,
          probeListening: retained,
          blockerListening: true,
          stopCalls: 1,
          lowerStops: 0,
          metadataRetains: 1,
          metadataReleases: retained ? 0 : 1,
          nativeOwnerRetained: retained,
          fixtureRelease: refusal,
          afterEach: refusal,
          cleanup: refusal,
          successorSetup: refusal,
          successorStarted: !retained,
          homeRestored: !retained,
          beforeCleanup: { home: true, state: true, selectorsIntact: true },
          afterCleanup: state,
          afterSuccessor: state,
          finally: {
            originalsJoined: true,
            nativeCloseCalls: 1,
            listenerResults: ["fulfilled", "fulfilled"],
            probeListening: false,
            blockerListening: false,
          },
        });
        if (!scenario.missingTls) {
          expect(journal, text).toMatchObject({ startupCode: "EADDRINUSE" });
        }
      },
    ));
}
