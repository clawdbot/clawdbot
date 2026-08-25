import { vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig, OpenClawConfigInput } from "../config/config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import "./doctor-health-contributions.js";
import type { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheckInput, RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorContributionHealthCheck =
  | (Omit<HealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    })
  | (Omit<RunnableHealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    });

type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  healthChecks: readonly HealthCheckInput[];
  healthCheckIds: readonly string[];
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

type DoctorHealthContributionTestApi = {
  createDoctorHealthContribution(params: {
    id: string;
    label: string;
    healthCheckIds?: readonly string[];
    healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
    hint?: string;
    run?: (ctx: DoctorHealthFlowContext) => Promise<void>;
  }): DoctorHealthContribution;
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

export function createDoctorHealthContribution(
  params: Parameters<DoctorHealthContributionTestApi["createDoctorHealthContribution"]>[0],
): DoctorHealthContribution {
  return getTestApi().createDoctorHealthContribution(params);
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
