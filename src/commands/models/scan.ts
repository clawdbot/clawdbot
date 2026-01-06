import { cancel, isCancel, multiselect } from "@clack/prompts";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import {
  type ModelScanResult,
  scanOpenRouterModels,
} from "../../agents/model-scan.js";
import { CONFIG_PATH_CLAWDBOT, loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { formatMs, formatTokenK, updateConfig } from "./shared.js";

const MODEL_PAD = 42;
const CTX_PAD = 8;

const pad = (value: string, size: number) => value.padEnd(size);

const truncate = (value: string, max: number) => {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
};

function sortScanResults(results: ModelScanResult[]): ModelScanResult[] {
  return results.slice().sort((a, b) => {
    const aImage = a.image.ok ? 1 : 0;
    const bImage = b.image.ok ? 1 : 0;
    if (aImage !== bImage) return bImage - aImage;

    const aToolLatency = a.tool.latencyMs ?? Number.POSITIVE_INFINITY;
    const bToolLatency = b.tool.latencyMs ?? Number.POSITIVE_INFINITY;
    if (aToolLatency !== bToolLatency) return aToolLatency - bToolLatency;

    const aCtx = a.contextLength ?? 0;
    const bCtx = b.contextLength ?? 0;
    if (aCtx !== bCtx) return bCtx - aCtx;

    const aParams = a.inferredParamB ?? 0;
    const bParams = b.inferredParamB ?? 0;
    if (aParams !== bParams) return bParams - aParams;

    return a.modelRef.localeCompare(b.modelRef);
  });
}

function sortImageResults(results: ModelScanResult[]): ModelScanResult[] {
  return results.slice().sort((a, b) => {
    const aLatency = a.image.latencyMs ?? Number.POSITIVE_INFINITY;
    const bLatency = b.image.latencyMs ?? Number.POSITIVE_INFINITY;
    if (aLatency !== bLatency) return aLatency - bLatency;

    const aCtx = a.contextLength ?? 0;
    const bCtx = b.contextLength ?? 0;
    if (aCtx !== bCtx) return bCtx - aCtx;

    const aParams = a.inferredParamB ?? 0;
    const bParams = b.inferredParamB ?? 0;
    if (aParams !== bParams) return bParams - aParams;

    return a.modelRef.localeCompare(b.modelRef);
  });
}

function buildScanHint(result: ModelScanResult): string {
  const toolLabel = result.tool.ok
    ? `tool ${formatMs(result.tool.latencyMs)}`
    : "tool fail";
  const imageLabel = result.image.skipped
    ? "img skip"
    : result.image.ok
      ? `img ${formatMs(result.image.latencyMs)}`
      : "img fail";
  const ctxLabel = result.contextLength
    ? `ctx ${formatTokenK(result.contextLength)}`
    : "ctx ?";
  const paramLabel = result.inferredParamB ? `${result.inferredParamB}b` : null;
  return [toolLabel, imageLabel, ctxLabel, paramLabel]
    .filter(Boolean)
    .join(" | ");
}

function printScanSummary(results: ModelScanResult[], runtime: RuntimeEnv) {
  const toolOk = results.filter((r) => r.tool.ok);
  const imageOk = results.filter((r) => r.image.ok);
  const toolImageOk = results.filter((r) => r.tool.ok && r.image.ok);
  const imageOnly = imageOk.filter((r) => !r.tool.ok);
  runtime.log(
    `Scan results: tested ${results.length}, tool ok ${toolOk.length}, image ok ${imageOk.length}, tool+image ok ${toolImageOk.length}, image only ${imageOnly.length}`,
  );
}

function printScanTable(results: ModelScanResult[], runtime: RuntimeEnv) {
  const header = [
    pad("Model", MODEL_PAD),
    pad("Tool", 10),
    pad("Image", 10),
    pad("Ctx", CTX_PAD),
    pad("Params", 8),
    "Notes",
  ].join(" ");
  runtime.log(header);

  for (const entry of results) {
    const modelLabel = pad(truncate(entry.modelRef, MODEL_PAD), MODEL_PAD);
    const toolLabel = pad(
      entry.tool.ok ? formatMs(entry.tool.latencyMs) : "fail",
      10,
    );
    const imageLabel = pad(
      entry.image.ok
        ? formatMs(entry.image.latencyMs)
        : entry.image.skipped
          ? "skip"
          : "fail",
      10,
    );
    const ctxLabel = pad(formatTokenK(entry.contextLength), CTX_PAD);
    const paramsLabel = pad(
      entry.inferredParamB ? `${entry.inferredParamB}b` : "-",
      8,
    );
    const notes = entry.modality ? `modality:${entry.modality}` : "";

    runtime.log(
      [modelLabel, toolLabel, imageLabel, ctxLabel, paramsLabel, notes].join(
        " ",
      ),
    );
  }
}

export async function modelsScanCommand(
  opts: {
    minParams?: string;
    maxAgeDays?: string;
    provider?: string;
    maxCandidates?: string;
    timeout?: string;
    concurrency?: string;
    yes?: boolean;
    input?: boolean;
    setDefault?: boolean;
    setImage?: boolean;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const minParams = opts.minParams ? Number(opts.minParams) : undefined;
  if (
    minParams !== undefined &&
    (!Number.isFinite(minParams) || minParams < 0)
  ) {
    throw new Error("--min-params must be >= 0");
  }
  const maxAgeDays = opts.maxAgeDays ? Number(opts.maxAgeDays) : undefined;
  if (
    maxAgeDays !== undefined &&
    (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)
  ) {
    throw new Error("--max-age-days must be >= 0");
  }
  const maxCandidates = opts.maxCandidates ? Number(opts.maxCandidates) : 6;
  if (!Number.isFinite(maxCandidates) || maxCandidates <= 0) {
    throw new Error("--max-candidates must be > 0");
  }
  const timeout = opts.timeout ? Number(opts.timeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("--timeout must be > 0");
  }
  const concurrency = opts.concurrency ? Number(opts.concurrency) : undefined;
  if (
    concurrency !== undefined &&
    (!Number.isFinite(concurrency) || concurrency <= 0)
  ) {
    throw new Error("--concurrency must be > 0");
  }

  const cfg = loadConfig();
  let storedKey: string | undefined;
  try {
    const resolved = await resolveApiKeyForProvider({
      provider: "openrouter",
      cfg,
    });
    storedKey = resolved.apiKey;
  } catch {
    storedKey = undefined;
  }
  const results = await scanOpenRouterModels({
    apiKey: storedKey ?? undefined,
    minParamB: minParams,
    maxAgeDays,
    providerFilter: opts.provider,
    timeoutMs: timeout,
    concurrency,
  });

  const toolOk = results.filter((entry) => entry.tool.ok);
  if (toolOk.length === 0) {
    throw new Error("No tool-capable OpenRouter free models found.");
  }

  const sorted = sortScanResults(results);
  const toolSorted = sortScanResults(toolOk);
  const imageOk = results.filter((entry) => entry.image.ok);
  const imageSorted = sortImageResults(imageOk);
  const imagePreferred = toolSorted.filter((entry) => entry.image.ok);
  const preselectPool = imagePreferred.length > 0 ? imagePreferred : toolSorted;
  const preselected = preselectPool
    .slice(0, Math.floor(maxCandidates))
    .map((entry) => entry.modelRef);
  const imagePreselected = imageSorted
    .slice(0, Math.floor(maxCandidates))
    .map((entry) => entry.modelRef);

  if (!opts.json) {
    printScanSummary(results, runtime);
    printScanTable(sorted, runtime);
  }

  const noInput = opts.input === false;
  const canPrompt = process.stdin.isTTY && !opts.yes && !noInput && !opts.json;
  let selected: string[] = preselected;
  let selectedImages: string[] = imagePreselected;

  if (canPrompt) {
    const selection = await multiselect({
      message: "Select fallback models (ordered)",
      options: toolSorted.map((entry) => ({
        value: entry.modelRef,
        label: entry.modelRef,
        hint: buildScanHint(entry),
      })),
      initialValues: preselected,
    });

    if (isCancel(selection)) {
      cancel("Model scan cancelled.");
      runtime.exit(0);
    }

    selected = selection as string[];
    if (imageSorted.length > 0) {
      const imageSelection = await multiselect({
        message: "Select image fallback models (ordered)",
        options: imageSorted.map((entry) => ({
          value: entry.modelRef,
          label: entry.modelRef,
          hint: buildScanHint(entry),
        })),
        initialValues: imagePreselected,
      });

      if (isCancel(imageSelection)) {
        cancel("Model scan cancelled.");
        runtime.exit(0);
      }

      selectedImages = imageSelection as string[];
    }
  } else if (!process.stdin.isTTY && !opts.yes && !noInput && !opts.json) {
    throw new Error("Non-interactive scan: pass --yes to apply defaults.");
  }

  if (selected.length === 0) {
    throw new Error("No models selected for fallbacks.");
  }
  if (opts.setImage && selectedImages.length === 0) {
    throw new Error("No image-capable models selected for image model.");
  }

  const _updated = await updateConfig((cfg) => {
    const nextModels = { ...cfg.agent?.models };
    for (const entry of selected) {
      if (!nextModels[entry]) nextModels[entry] = {};
    }
    for (const entry of selectedImages) {
      if (!nextModels[entry]) nextModels[entry] = {};
    }
    const existingImageModel = cfg.agent?.imageModel as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    const nextImageModel =
      selectedImages.length > 0
        ? {
            ...(existingImageModel?.primary
              ? { primary: existingImageModel.primary }
              : undefined),
            fallbacks: selectedImages,
            ...(opts.setImage ? { primary: selectedImages[0] } : {}),
          }
        : cfg.agent?.imageModel;
    const existingModel = cfg.agent?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    const agent = {
      ...cfg.agent,
      model: {
        ...(existingModel?.primary
          ? { primary: existingModel.primary }
          : undefined),
        fallbacks: selected,
        ...(opts.setDefault ? { primary: selected[0] } : {}),
      },
      ...(nextImageModel ? { imageModel: nextImageModel } : {}),
      models: nextModels,
    } satisfies NonNullable<typeof cfg.agent>;
    return {
      ...cfg,
      agent,
    };
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          selected,
          selectedImages,
          setDefault: Boolean(opts.setDefault),
          setImage: Boolean(opts.setImage),
          results,
          warnings: [],
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Fallbacks: ${selected.join(", ")}`);
  if (selectedImages.length > 0) {
    runtime.log(`Image fallbacks: ${selectedImages.join(", ")}`);
  }
  if (opts.setDefault) {
    runtime.log(`Default model: ${selected[0]}`);
  }
  if (opts.setImage && selectedImages.length > 0) {
    runtime.log(`Image model: ${selectedImages[0]}`);
  }
}
