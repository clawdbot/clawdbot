// Discord plugin module implements components.base behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { BaseComponentInteraction } from "./interactions.js";

export type ComponentParserResult = {
  key: string;
  data: Record<string, string | boolean>;
};
export type ComponentData<
  T extends keyof ComponentParserResult["data"] = keyof ComponentParserResult["data"],
> = {
  [K in T]: ComponentParserResult["data"][K];
};
type ConditionalComponentOption = (interaction: BaseComponentInteraction) => boolean;

export function parseCustomId(id: string): ComponentParserResult {
  const [rawKeyValue, ...parts] = id.split(";");
  const rawKey = expectDefined(rawKeyValue, "custom id split first segment");
  const [keyPart, firstValue] = rawKey.split("=");
  const definedKeyPart = expectDefined(keyPart, "custom id key segment");
  const key = definedKeyPart.includes(":")
    ? expectDefined(definedKeyPart.split(":").at(0), "namespaced custom id key")
    : definedKeyPart;
  const data: ComponentParserResult["data"] = {};
  const entries = firstValue === undefined ? parts : [rawKey.slice(key.length + 1), ...parts];
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index < 0) {
      continue;
    }
    const name = entry.slice(0, index).replace(/^[^:]+:/, "");
    const raw = entry.slice(index + 1);
    data[name] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  return { key, data };
}

export function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function colorToNumber(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : undefined;
  }
  if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)) {
    return Number.parseInt(value.replace(/^#/, ""), 16);
  }
  return undefined;
}

export abstract class BaseComponent {
  abstract readonly type: number;
  readonly isV2: boolean = false;
  abstract serialize(): unknown;
}

export abstract class BaseMessageInteractiveComponent extends BaseComponent {
  override readonly isV2 = false;
  defer: boolean | ConditionalComponentOption = false;
  ephemeral: boolean | ConditionalComponentOption = false;
  abstract customId: string;
  customIdParser = parseCustomId;
  run(_interaction: BaseComponentInteraction, _data: ComponentData): unknown {
    return undefined;
  }
}

export abstract class BaseModalComponent extends BaseComponent {
  abstract customId: string;
}
