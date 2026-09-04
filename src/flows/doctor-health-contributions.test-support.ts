import { vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig, OpenClawConfigInput } from "../config/config.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import "./doctor-health-contributions.js";
import type { runDoctorLintChecks } from "./doctor-lint-flow.js";

type DoctorHealthContributionTestApi = {
  resolveDoctorHealthContributions(): DoctorHealthContribution[];
  runDoctorHealthContributionList(
    ctx: DoctorHealthFlowContext,
    contributions: readonly DoctorHealthContribution[],
  ): Promise<void>;
};

type DoctorHealthFlowContextFixture = Partial<Omit<DoctorHealthFlowContext, "configResult">> & {
  configResult?: Partial<DoctorHealthFlowContext["configResult"]>;
};

type DoctorLintContext = Parameters<typeof runDoctorLintChecks>[0];

export function createDoctorConfigFixture(input: OpenClawConfigInput): OpenClawConfig {
  return input as OpenClawConfig;
}

export function createDoctorLintContext(
  fixture: Pick<DoctorLintContext, "cfg"> & Partial<Omit<DoctorLintContext, "cfg">>,
): DoctorLintContext {
  return fixture as DoctorLintContext;
}

function createDoctorPrompterFixture(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

export function createDoctorHealthFlowContext(
  overrides: DoctorHealthFlowContextFixture = {},
): DoctorHealthFlowContext {
  const { configResult, ...contextOverrides } = overrides;
  const cfg = overrides.cfg ?? {};
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: createDoctorPrompterFixture(),
    configResult: { ...configResult, cfg: configResult?.cfg ?? cfg },
    cfg,
    cfgForPersistence: cfg,
    sourceConfigValid: true,
    configPath: "/tmp/openclaw.json",
    ...contextOverrides,
  };
}

function getTestApi(): DoctorHealthContributionTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ];
  if (!api) {
    throw new Error("doctor health contributions test API is unavailable");
  }
  return api as DoctorHealthContributionTestApi;
}

export function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return getTestApi().resolveDoctorHealthContributions();
}

export async function runDoctorHealthContributionList(
  ctx: DoctorHealthFlowContext,
  contributions: readonly DoctorHealthContribution[],
): Promise<void> {
  await getTestApi().runDoctorHealthContributionList(ctx, contributions);
}
