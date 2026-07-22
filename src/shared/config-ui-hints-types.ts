export type ConfigUiPresentation = "phone-number";

/** UI metadata attached to config schema paths for forms, docs, and redaction policy. */
export type ConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  presentation?: ConfigUiPresentation;
  itemTemplate?: unknown;
};

/** Config UI hints keyed by dotted config path, with `*` matching dynamic segments. */
export type ConfigUiHints = Record<string, ConfigUiHint>;
