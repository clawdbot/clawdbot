import { open } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import type { DiscordSourceConfig, GithubSourceConfig, Person } from "./types.js";

const nonempty = z.string().min(1).regex(/\S/);
const secretInputSchema = z.union([
  nonempty,
  z.strictObject({
    source: z.enum(["env", "file", "exec", "store"]),
    provider: nonempty,
    id: nonempty,
  }),
]);
const personSchema = z.strictObject({
  github: z.array(nonempty).min(1),
  display: nonempty.optional(),
  affiliation: nonempty.optional(),
  roleGroup: nonempty.optional(),
  roleLabel: nonempty.optional(),
  access: z.array(nonempty).optional(),
  areas: z.array(nonempty).optional(),
  discordUserId: z.string().regex(/^\d+$/).optional(),
  discordUsername: nonempty.optional(),
  status: z.enum(["active", "archived"]).optional(),
  archivedAt: z.iso.date().optional(),
});
const githubSchema = z.strictObject({
  token: secretInputSchema,
  orgs: z.array(nonempty).min(1),
  teams: z.array(z.strictObject({ org: nonempty, slug: nonempty })).default([]),
  includeDirectCollaborators: z.boolean().default(false),
  excludeRepos: z.array(nonempty).default([]),
  apiBaseUrl: z
    .string()
    .regex(/^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/)
    .default("https://api.github.com"),
  ignoreCommentPatterns: z.array(z.string()).default([]),
});
const summariesSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: nonempty.optional(),
  reasoning: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"])
    .optional(),
  agentId: nonempty.optional(),
});
const scheduleSchema = z.strictObject({
  closedDayUtc: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .default("00:05"),
  intradayEveryHours: z.number().int().min(0).max(24).default(4),
  jitterMinutes: z.number().int().min(0).max(59).default(5),
  weekly: z.boolean().default(true),
  monthly: z.boolean().default(true),
});
const retentionSchema = z.strictObject({ days: z.number().int().min(0).default(400) });

const teamReportsConfigSchema = z
  .strictObject({
    basePath: z
      .string()
      .regex(
        /^\/(?!api\/channels(?:\/|$))(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/*$/,
      )
      .default("/reports"),
    displayTimezone: nonempty.default("UTC"),
    github: githubSchema,
    discord: z
      .strictObject({
        token: secretInputSchema,
        guildId: z.string().regex(/^\d+$/),
        channels: z
          .array(
            z.strictObject({ id: z.string().regex(/^\d+$/), excerpts: z.boolean().default(false) }),
          )
          .min(1),
        excerptMaxChars: z.number().int().min(1).max(4000).default(260),
      })
      .optional(),
    people: z.array(personSchema).optional(),
    peopleFile: z
      .string()
      .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\0]*$/)
      .optional(),
    summaries: summariesSchema.prefault({}),
    schedule: scheduleSchema.prefault({}),
    retention: retentionSchema.prefault({}),
  })
  .superRefine((config, context) => {
    if (config.people !== undefined && config.peopleFile !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["peopleFile"],
        message: "people and peopleFile are mutually exclusive.",
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: config.displayTimezone }).resolvedOptions();
    } catch {
      context.addIssue({
        code: "custom",
        path: ["displayTimezone"],
        message: "Expected an IANA time zone.",
      });
    }
    for (const [index, pattern] of config.github.ignoreCommentPatterns.entries()) {
      try {
        RegExp(pattern);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["github", "ignoreCommentPatterns", index],
          message: "Expected a valid regular expression.",
        });
      }
    }
  });

export type TeamReportsConfig = z.infer<typeof teamReportsConfigSchema>;

export function parseTeamReportsConfig(
  value: unknown,
  controlUiBasePath?: string,
): TeamReportsConfig {
  const config = teamReportsConfigSchema.parse(value);
  config.basePath = config.basePath.replace(/\/+$/, "");
  const controlPath = controlUiBasePath?.replace(/\/+$/, "");
  // The root UI shares the Gateway with plugin routes; only an explicitly mounted UI reserves a prefix.
  if (
    controlPath &&
    (config.basePath === controlPath || config.basePath.startsWith(`${controlPath}/`))
  ) {
    throw new Error("team-reports.basePath must not equal or nest the Control UI base path.");
  }
  return config;
}

const peopleFileSchema = z.strictObject({ people: z.array(personSchema) });
const MAX_PEOPLE_FILE_BYTES = 2 * 1024 * 1024;

async function readPeopleFile(filePath: string): Promise<Person[]> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PEOPLE_FILE_BYTES) {
      throw new Error("team-reports.peopleFile must be a regular JSON file of at most 2 MiB.");
    }
    const data: unknown = JSON.parse(await handle.readFile("utf8"));
    return peopleFileSchema.parse(data).people;
  } finally {
    await handle.close();
  }
}

export async function resolveTeamReportsConfig(
  config: TeamReportsConfig,
  fullConfig: OpenClawConfig,
): Promise<{ github: GithubSourceConfig; discord?: DiscordSourceConfig; people: Person[] }> {
  const people = config.peopleFile
    ? await readPeopleFile(config.peopleFile)
    : (config.people ?? []);
  const { applyResolvedAssignments, createResolverContext, resolveSecretRefValues } =
    await import("openclaw/plugin-sdk/secret-ref-runtime");
  const context = createResolverContext({ sourceConfig: fullConfig, env: process.env });
  const tokens: Record<"github" | "discord", string> = { github: "", discord: "" };
  for (const name of ["github", "discord"] as const) {
    const token = config[name]?.token;
    if (token === undefined) {
      continue;
    }
    if (typeof token === "string") {
      tokens[name] = token;
      continue;
    }
    context.assignments.push({
      ref: token,
      path: `plugins.entries.team-reports.config.${name}.token`,
      expected: "string",
      ownerKind: "capability",
      ownerId: `team-reports.${name}`,
      requiredForGateway: false,
      disposition: "fail-closed",
      apply(value) {
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`team-reports.${name}.token resolved to an empty or non-string value.`);
        }
        tokens[name] = value;
      },
    });
  }
  if (context.assignments.length > 0) {
    try {
      const resolved = await resolveSecretRefValues(
        context.assignments.map(({ ref }) => ref),
        {
          config: fullConfig,
          env: context.env,
          cache: context.cache,
        },
      );
      applyResolvedAssignments({ assignments: context.assignments, resolved });
    } catch {
      // Provider errors can include secret identifiers or material; expose only the affected capability.
      throw new Error(
        "Team Reports could not resolve its source credentials. Check the configured SecretRefs and restart the Gateway.",
      );
    }
  }
  return {
    github: {
      ...config.github,
      token: tokens.github,
      apiBaseUrl: config.github.apiBaseUrl.replace(/\/+$/, ""),
      ignoreCommentPatterns: config.github.ignoreCommentPatterns.map(
        (pattern) => new RegExp(pattern),
      ),
    },
    ...(config.discord
      ? {
          discord: {
            ...config.discord,
            token: tokens.discord,
            apiBaseUrl: "https://discord.com/api/v10",
          },
        }
      : {}),
    people,
  };
}
