import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "openclaw/plugin-sdk/zod";
import type { OpenClawPluginConfigSchema } from "../api.js";
import {
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_INDICATORS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES,
  type DiffFileDefaults,
  type DiffImageQualityPreset,
  type DiffIndicators,
  type DiffLayout,
  type DiffMode,
  type DiffOutputFormat,
  type DiffPresentationDefaults,
  type DiffTheme,
  type DiffToolDefaults,
} from "./types.js";
import { normalizeViewerBaseUrl } from "./url.js";

type DiffsPluginConfig = {
  viewerBaseUrl?: string;
  defaults?: {
    fontFamily?: string;
    fontSize?: number;
    lineSpacing?: number;
    layout?: DiffLayout;
    showLineNumbers?: boolean;
    diffIndicators?: DiffIndicators;
    wordWrap?: boolean;
    background?: boolean;
    theme?: DiffTheme;
    fileFormat?: DiffOutputFormat;
    fileQuality?: DiffImageQualityPreset;
    fileScale?: number;
    fileMaxWidth?: number;
    format?: DiffOutputFormat;
    // Backward-compatible aliases retained for existing configs.
    imageFormat?: DiffOutputFormat;
    imageQuality?: DiffImageQualityPreset;
    imageScale?: number;
    imageMaxWidth?: number;
    mode?: DiffMode;
  };
  security?: {
    allowRemoteViewer?: boolean;
  };
};

const DEFAULT_IMAGE_QUALITY_PROFILES = {
  standard: {
    scale: 2,
    maxWidth: 960,
    maxPixels: 8_000_000,
  },
  hq: {
    scale: 2.5,
    maxWidth: 1200,
    maxPixels: 14_000_000,
  },
  print: {
    scale: 3,
    maxWidth: 1400,
    maxPixels: 24_000_000,
  },
} as const satisfies Record<
  DiffImageQualityPreset,
  { scale: number; maxWidth: number; maxPixels: number }
>;

export const DEFAULT_DIFFS_TOOL_DEFAULTS: DiffToolDefaults = {
  fontFamily: "Fira Code",
  fontSize: 15,
  lineSpacing: 1.6,
  layout: "unified",
  showLineNumbers: true,
  diffIndicators: "bars",
  wordWrap: true,
  background: true,
  theme: "dark",
  fileFormat: "png",
  fileQuality: "standard",
  fileScale: DEFAULT_IMAGE_QUALITY_PROFILES.standard.scale,
  fileMaxWidth: DEFAULT_IMAGE_QUALITY_PROFILES.standard.maxWidth,
  mode: "both",
};

export type DiffsPluginSecurityConfig = {
  allowRemoteViewer: boolean;
};

export const DEFAULT_DIFFS_PLUGIN_SECURITY: DiffsPluginSecurityConfig = {
  allowRemoteViewer: false,
};

const VIEWER_BASE_URL_JSON_SCHEMA = {
  type: "string",
  format: "uri",
  pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
  not: {
    pattern: "[?#]",
  },
} as const satisfies Record<string, unknown>;

const DiffsPluginJsonSchemaSource = z.strictObject({
  viewerBaseUrl: z
    .string()
    .superRefine((value, ctx) => {
      try {
        normalizeViewerBaseUrl(value, "viewerBaseUrl");
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid viewerBaseUrl",
        });
      }
    })
    .optional(),
  defaults: z
    .strictObject({
      fontFamily: z.string().default(DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily).optional(),
      fontSize: z.number().min(10).max(24).default(DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize).optional(),
      lineSpacing: z
        .number()
        .min(1)
        .max(3)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing)
        .optional(),
      layout: z.enum(DIFF_LAYOUTS).default(DEFAULT_DIFFS_TOOL_DEFAULTS.layout).optional(),
      showLineNumbers: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.showLineNumbers).optional(),
      diffIndicators: z
        .enum(DIFF_INDICATORS)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators)
        .optional(),
      wordWrap: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.wordWrap).optional(),
      background: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.background).optional(),
      theme: z.enum(DIFF_THEMES).default(DEFAULT_DIFFS_TOOL_DEFAULTS.theme).optional(),
      fileFormat: z
        .enum(DIFF_OUTPUT_FORMATS)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat)
        .optional(),
      format: z.enum(DIFF_OUTPUT_FORMATS).optional(),
      fileQuality: z
        .enum(DIFF_IMAGE_QUALITY_PRESETS)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality)
        .optional(),
      fileScale: z.number().min(1).max(4).optional(),
      fileMaxWidth: z.number().min(640).max(2400).optional(),
      imageFormat: z.enum(DIFF_OUTPUT_FORMATS).optional(),
      imageQuality: z.enum(DIFF_IMAGE_QUALITY_PRESETS).optional(),
      imageScale: z.number().min(1).max(4).optional(),
      imageMaxWidth: z.number().min(640).max(2400).optional(),
      mode: z.enum(DIFF_MODES).default(DEFAULT_DIFFS_TOOL_DEFAULTS.mode).optional(),
    })
    .optional(),
  security: z
    .strictObject({
      allowRemoteViewer: z
        .boolean()
        .default(DEFAULT_DIFFS_PLUGIN_SECURITY.allowRemoteViewer)
        .optional(),
    })
    .optional(),
});

const diffsPluginConfigSchemaBase = buildPluginConfigSchema(DiffsPluginJsonSchemaSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    const result = DiffsPluginJsonSchemaSource.safeParse(value);
    if (result.success) {
      return {
        success: true,
        data: buildDiffsPluginConfigShape(result.data as DiffsPluginConfig),
      };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});

export const diffsPluginConfigSchema: OpenClawPluginConfigSchema = {
  ...diffsPluginConfigSchemaBase,
  jsonSchema: {
    ...diffsPluginConfigSchemaBase.jsonSchema,
    properties: {
      ...(diffsPluginConfigSchemaBase.jsonSchema as { properties?: Record<string, unknown> })
        .properties,
      viewerBaseUrl: VIEWER_BASE_URL_JSON_SCHEMA,
    },
  },
};

function resolveConfiguredValue<T>(options: {
  primary: T | undefined;
  aliases: Array<T | undefined>;
  schemaDefault?: T;
}): T | undefined {
  const alias = options.aliases.find((value): value is T => value !== undefined);
  if (alias !== undefined && options.primary === options.schemaDefault) {
    return alias;
  }
  return options.primary ?? alias;
}

function buildDiffsPluginConfigShape(config: DiffsPluginConfig): DiffsPluginConfig {
  const viewerBaseUrl = resolveDiffsPluginViewerBaseUrl(config);
  return {
    ...(viewerBaseUrl !== undefined ? { viewerBaseUrl } : {}),
    ...(config.defaults !== undefined ? { defaults: resolveDiffsPluginDefaults(config) } : {}),
    ...(config.security !== undefined ? { security: resolveDiffsPluginSecurity(config) } : {}),
  };
}

export function resolveDiffsPluginDefaults(config: unknown): DiffToolDefaults {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  const defaults = (config as DiffsPluginConfig).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  const fileQuality = normalizeFileQuality(
    resolveConfiguredValue({
      primary: defaults.fileQuality,
      aliases: [defaults.imageQuality],
      schemaDefault: DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality,
    }),
  );
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[fileQuality];
  const fileFormat = resolveConfiguredValue({
    primary: defaults.fileFormat,
    aliases: [defaults.imageFormat, defaults.format],
    schemaDefault: DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat,
  });
  const fileScale = resolveConfiguredValue({
    primary: defaults.fileScale,
    aliases: [defaults.imageScale],
  });
  const fileMaxWidth = resolveConfiguredValue({
    primary: defaults.fileMaxWidth,
    aliases: [defaults.imageMaxWidth],
  });

  return {
    fontFamily: normalizeFontFamily(defaults.fontFamily),
    fontSize: normalizeFontSize(defaults.fontSize),
    lineSpacing: normalizeLineSpacing(defaults.lineSpacing),
    layout: normalizeLayout(defaults.layout),
    showLineNumbers: defaults.showLineNumbers !== false,
    diffIndicators: normalizeDiffIndicators(defaults.diffIndicators),
    wordWrap: defaults.wordWrap !== false,
    background: defaults.background !== false,
    theme: normalizeTheme(defaults.theme),
    fileFormat: normalizeFileFormat(fileFormat),
    fileQuality,
    fileScale: normalizeFileScale(fileScale, profile.scale),
    fileMaxWidth: normalizeFileMaxWidth(fileMaxWidth, profile.maxWidth),
    mode: normalizeMode(defaults.mode),
  };
}

export function resolveDiffsPluginSecurity(config: unknown): DiffsPluginSecurityConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
  }

  const security = (config as DiffsPluginConfig).security;
  if (!security || typeof security !== "object" || Array.isArray(security)) {
    return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
  }

  return {
    allowRemoteViewer: security.allowRemoteViewer === true,
  };
}

export function resolveDiffsPluginViewerBaseUrl(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }

  const viewerBaseUrl = (config as DiffsPluginConfig).viewerBaseUrl;
  if (typeof viewerBaseUrl !== "string") {
    return undefined;
  }

  const normalized = viewerBaseUrl.trim();
  return normalized ? normalizeViewerBaseUrl(normalized) : undefined;
}

export function toPresentationDefaults(defaults: DiffToolDefaults): DiffPresentationDefaults {
  const {
    fontFamily,
    fontSize,
    lineSpacing,
    layout,
    showLineNumbers,
    diffIndicators,
    wordWrap,
    background,
    theme,
  } = defaults;
  return {
    fontFamily,
    fontSize,
    lineSpacing,
    layout,
    showLineNumbers,
    diffIndicators,
    wordWrap,
    background,
    theme,
  };
}

function normalizeFontFamily(fontFamily?: string): string {
  const normalized = fontFamily?.trim();
  return normalized || DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily;
}

function normalizeFontSize(fontSize?: number): number {
  if (fontSize === undefined || !Number.isFinite(fontSize)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize;
  }
  const rounded = Math.floor(fontSize);
  return Math.min(Math.max(rounded, 10), 24);
}

function normalizeLineSpacing(lineSpacing?: number): number {
  if (lineSpacing === undefined || !Number.isFinite(lineSpacing)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing;
  }
  return Math.min(Math.max(lineSpacing, 1), 3);
}

function normalizeLayout(layout?: DiffLayout): DiffLayout {
  return layout && DIFF_LAYOUTS.includes(layout) ? layout : DEFAULT_DIFFS_TOOL_DEFAULTS.layout;
}

function normalizeDiffIndicators(diffIndicators?: DiffIndicators): DiffIndicators {
  return diffIndicators && DIFF_INDICATORS.includes(diffIndicators)
    ? diffIndicators
    : DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators;
}

function normalizeTheme(theme?: DiffTheme): DiffTheme {
  return theme && DIFF_THEMES.includes(theme) ? theme : DEFAULT_DIFFS_TOOL_DEFAULTS.theme;
}

function normalizeFileFormat(fileFormat?: DiffOutputFormat): DiffOutputFormat {
  return fileFormat && DIFF_OUTPUT_FORMATS.includes(fileFormat)
    ? fileFormat
    : DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat;
}

function normalizeFileQuality(fileQuality?: DiffImageQualityPreset): DiffImageQualityPreset {
  return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality)
    ? fileQuality
    : DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality;
}

function normalizeFileScale(fileScale: number | undefined, fallback: number): number {
  if (fileScale === undefined || !Number.isFinite(fileScale)) {
    return fallback;
  }
  const rounded = Math.round(fileScale * 100) / 100;
  return Math.min(Math.max(rounded, 1), 4);
}

function normalizeFileMaxWidth(fileMaxWidth: number | undefined, fallback: number): number {
  if (fileMaxWidth === undefined || !Number.isFinite(fileMaxWidth)) {
    return fallback;
  }
  const rounded = Math.round(fileMaxWidth);
  return Math.min(Math.max(rounded, 640), 2400);
}

function normalizeMode(mode?: DiffMode): DiffMode {
  return mode && DIFF_MODES.includes(mode) ? mode : DEFAULT_DIFFS_TOOL_DEFAULTS.mode;
}

export function resolveDiffImageRenderOptions(params: {
  defaults: DiffFileDefaults;
  fileFormat?: DiffOutputFormat;
  format?: DiffOutputFormat;
  fileQuality?: DiffImageQualityPreset;
  fileScale?: number;
  fileMaxWidth?: number;
  imageFormat?: DiffOutputFormat;
  imageQuality?: DiffImageQualityPreset;
  imageScale?: number;
  imageMaxWidth?: number;
}): {
  format: DiffOutputFormat;
  qualityPreset: DiffImageQualityPreset;
  scale: number;
  maxWidth: number;
  maxPixels: number;
} {
  const format = normalizeFileFormat(
    params.fileFormat ?? params.imageFormat ?? params.format ?? params.defaults.fileFormat,
  );
  const qualityOverrideProvided =
    params.fileQuality !== undefined || params.imageQuality !== undefined;
  const qualityPreset = normalizeFileQuality(
    params.fileQuality ?? params.imageQuality ?? params.defaults.fileQuality,
  );
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[qualityPreset];

  const scale = normalizeFileScale(
    params.fileScale ?? params.imageScale,
    qualityOverrideProvided ? profile.scale : params.defaults.fileScale,
  );
  const maxWidth = normalizeFileMaxWidth(
    params.fileMaxWidth ?? params.imageMaxWidth,
    qualityOverrideProvided ? profile.maxWidth : params.defaults.fileMaxWidth,
  );

  return {
    format,
    qualityPreset,
    scale,
    maxWidth,
    maxPixels: profile.maxPixels,
  };
}
