import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  credential,
  cleanupWorkerTurnLauncherTest,
  computerDescriptor,
  createWorkerSessionTurnPlacementProvider,
  measureLaunchTurn,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

const prepareGitHubBinding = vi.hoisted(() => vi.fn());
vi.mock("./worker-github-binding.js", () => ({
  prepareWorkerGitHubBinding: prepareGitHubBinding,
}));

describe("worker launch capabilities", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  beforeEach(() => {
    prepareGitHubBinding.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([true, false])(
    "carries only an available GitHub identity in the launch envelope (%s)",
    async (available) => {
      seedActivePlacement();
      const github: WorkerGitHubLaunchBinding = {
        token: "synthetic-turn-bound-github-token",
        login: "shared-bot",
        branch: "openclaw/session-branch",
        remoteUrl: "https://github.com/owner/repo.git",
        gitAuthor: { name: "Shared Bot", email: "shared@example.test" },
      };
      prepareGitHubBinding.mockResolvedValue(available ? github : undefined);
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        if (available) {
          expect(plan.assignment.github).toEqual(github);
        } else {
          expect(plan.assignment).not.toHaveProperty("github");
        }
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        stageAttachments: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-github" },
          turn("run-github"),
          vi.fn(),
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { missingFeature: undefined, modelHasVision: undefined, allowed: true },
    { missingFeature: undefined, modelHasVision: true, allowed: true },
    { missingFeature: undefined, modelHasVision: false, allowed: false },
    { missingFeature: WORKER_COMPUTER_PROTOCOL_FEATURE, modelHasVision: true, allowed: false },
  ])(
    "grants computer with negotiated features and model vision (missing: $missingFeature, vision: $modelHasVision)",
    async ({ missingFeature, modelHasVision, allowed }) => {
      seedActivePlacement();
      const environment = attachedEnvironment();
      if (!missingFeature) {
        environment.bootstrapReceipt!.protocolFeatures.push(WORKER_COMPUTER_PROTOCOL_FEATURE);
      }
      const computer = computerDescriptor("worker-desktop");
      const image = {
        type: "image" as const,
        data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
        mimeType: "image/png",
      };
      const bind = vi.fn(() => ({ resolveNode: async () => computer, invoke: vi.fn() }));
      const prepareComputer = vi.fn(async () => ({
        descriptor: computer,
        bind,
        close: vi.fn(async () => {}),
      }));
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        expect(plan.assignment.computer).toEqual(allowed ? computer : undefined);
        const prompt = plan.assignment.prompt;
        const images = Array.isArray(prompt) ? prompt.filter((part) => part.type === "image") : [];
        expect(images).toEqual(modelHasVision === true ? [image] : []);
        expect(plan.assignment.toolAuthority.allowedToolNames.includes("computer")).toBe(allowed);
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        stageAttachments: vi.fn(async () => {}),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
        prepareComputer,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-computer",
          },
          { ...turn("run-computer"), toolsAllow: ["computer"], modelHasVision, images: [image] },
          async () => ({ meta: { durationMs: 1 } }),
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(tunnel.stageAttachments).toHaveBeenCalledTimes(modelHasVision === true ? 1 : 0);
      expect(prepareComputer).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(bind).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
});
