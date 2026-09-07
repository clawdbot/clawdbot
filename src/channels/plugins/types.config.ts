/**
 * Channel config schema type contracts.
 *
 * Defines JSON Schema metadata, UI hints, and runtime parser result shapes.
 */
import type { ConfigUiPresentation } from "../../shared/config-ui-hints-types.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";

/** Optional UI metadata for a JSON Schema property. */
export type ChannelConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  presentation?: ConfigUiPresentation;
  itemTemplate?: unknown;
};

/** Normalized validation issue emitted by a channel runtime parser. */
export type ChannelConfigRuntimeIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
} & Record<string, unknown>;

/** Minimal safeParse result shape accepted from channel-owned validators. */
export type ChannelConfigRuntimeParseResult =
  | {
      success: true;
      data: unknown;
    }
  | {
      success: false;
      issues: ChannelConfigRuntimeIssue[];
    };

/** Runtime validator contract paired with the JSON Schema config surface. */
export type ChannelConfigRuntimeSchema = {
  safeParse: (value: unknown) => ChannelConfigRuntimeParseResult;
};

/** Complete channel config schema description exposed to host tooling. */
export type ChannelConfigSchema = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};
