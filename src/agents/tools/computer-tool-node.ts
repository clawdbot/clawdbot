import crypto from "node:crypto";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseScreenSnapshotPayload } from "../../cli/nodes-screen.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  ComputerActParams,
  ComputerActResult,
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
  ScreenSnapshotParams,
} from "../../plugins/computer-use-contract.js";
import {
  COMPUTER_CONTRACT_MISMATCH,
  parseComputerActResult,
} from "../../plugins/computer-use-contract.js";
import {
  type EligibleNodeMessages,
  resolveEligibleNodeFromList,
} from "../../shared/node-resolve.js";
import { computerActionNeedsFrame, validateCapabilityBoundInput } from "./computer-tool-request.js";
import type {
  ComputerContextEpoch,
  ComputerFrame,
  ComputerObservationState,
  ComputerTarget,
  ComputerToolAction,
  ResolvedComputerTarget,
  ScreenshotCapture,
} from "./computer-tool-shared.js";
import {
  COMPUTER_ACT_COMMAND,
  SCREENSHOT_QUALITY,
  SCREEN_SNAPSHOT_COMMAND,
} from "./computer-tool-shared.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { listNodes, type NodeListNode } from "./nodes-utils.js";

type ComputerState =
  | { kind: "unbound" }
  | { kind: "target"; target: ComputerTarget }
  | ({ kind: "frame" } & ComputerFrame);

const NOT_COMPUTER_CAPABLE_HINT =
  "enable Computer Control in the OpenClaw app and approve the pairing update";
const DANGEROUS_DENY_HINT = "blocked by gateway.nodes.commands.deny";
const PLATFORM_ALLOWLIST_HINT = "is not in the allowlist for platform";
const BUTTON_NOT_HELD_HINT = "left button is not held by computer control";
const DEFINITIVE_NODE_COMMAND_REASONS = new Set([
  "command required",
  "command not allowlisted",
  "command not declared by node",
  "node did not declare commands",
]);

function isEligibleComputerNode(node: NodeListNode): boolean {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  // The tool loop authorizes coordinates against captured frames, so screenshot
  // support is a functional requirement rather than gating by platform name.
  return (
    node.connected === true &&
    commands.includes(COMPUTER_ACT_COMMAND) &&
    commands.includes(SCREEN_SNAPSHOT_COMMAND)
  );
}

const COMPUTER_NODE_MESSAGES: EligibleNodeMessages<NodeListNode> = {
  ineligibleExact: (query, eligibleIds) =>
    `node "${query}" is not computer-capable (needs a connected node advertising ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT}; ` +
    `eligible node ids: ${eligibleIds})`,
  nameResolveFailed: (reason, eligibleIds) =>
    `${reason} (eligible computer-capable node ids: ${eligibleIds})`,
  noneEligible: () =>
    `no connected computer-capable node (a node must advertise ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT})`,
  multipleEligible: (eligible) =>
    `multiple computer-capable nodes connected; pass node explicitly: ${eligible
      .map((node) => node.nodeId)
      .join(", ")}`,
};

async function resolveComputerNode(
  gatewayOpts: GatewayCallOptions,
  query?: string,
  signal?: AbortSignal,
): Promise<NodeListNode> {
  const nodes = await listNodes(gatewayOpts, signal);
  return resolveEligibleNodeFromList(nodes, query, isEligibleComputerNode, COMPUTER_NODE_MESSAGES);
}

async function invokeNodeCommand(params: {
  gatewayOpts: GatewayCallOptions;
  nodeId: string;
  command: string;
  commandParams: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const raw = await callGatewayTool<{ payload: unknown }>(
    "node.invoke",
    params.gatewayOpts,
    {
      nodeId: params.nodeId,
      command: params.command,
      params: params.commandParams,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
    },
    { signal: params.signal },
  );
  return raw && typeof raw === "object" && Object.hasOwn(raw, "payload")
    ? (raw as { payload: unknown }).payload
    : raw;
}

function parseComputerActPayload(value: unknown): ComputerActResult {
  if (typeof value !== "string") {
    return parseComputerActResult(value);
  }
  try {
    return parseComputerActResult(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(COMPUTER_CONTRACT_MISMATCH)) {
      throw error;
    }
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: computer.act returned invalid JSON`, {
      cause: error,
    });
  }
}

function computerActIdempotencyKey(params: { scope?: string; toolCallId: string }): string {
  const stableScope = params.scope?.trim();
  const stableCallId = params.toolCallId.trim();
  if (!stableScope || !stableCallId) {
    // A call id is only unique inside its model response. Without a stable run
    // scope and provider/fallback id, avoid collapsing unrelated actions.
    return crypto.randomUUID();
  }
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([stableScope, stableCallId, COMPUTER_ACT_COMMAND]))
    .digest("hex");
  // `v1` versions this key's composition (scope + call id + command), not the
  // `computer.act` wire contract. Changing what goes into the digest needs a
  // new prefix so in-flight keys from an older node cannot collide.
  return `computer.act:v1:${digest}`;
}

function gatewayRequestDetails(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error) || err.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (err as Error & { details?: unknown }).details;
  return isRecord(details) ? details : undefined;
}

function withComputerEnablementHint(err: unknown): Error {
  const message = formatErrorMessage(err);
  const reason = gatewayRequestDetails(err)?.reason;
  if (message.includes(DANGEROUS_DENY_HINT)) {
    return new Error(
      `${message} — remove ${COMPUTER_ACT_COMMAND} from gateway.nodes.commands.deny, then retry.`,
      { cause: err },
    );
  }
  if (
    reason === "command not allowlisted" ||
    reason === "command not declared by node" ||
    reason === "node did not declare commands" ||
    message.includes(PLATFORM_ALLOWLIST_HINT)
  ) {
    return new Error(`${message} — ${NOT_COMPUTER_CAPABLE_HINT}, then retry.`, { cause: err });
  }
  return err instanceof Error ? err : new Error(message);
}

function isDefinitiveComputerActRejection(err: unknown): boolean {
  const details = gatewayRequestDetails(err);
  return (
    details?.nodeCommandDispatched === false ||
    (typeof details?.reason === "string" && DEFINITIVE_NODE_COMMAND_REASONS.has(details.reason))
  );
}

function isButtonAlreadyReleasedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "GatewayClientRequestError" &&
    err.message.includes(BUTTON_NOT_HELD_HINT)
  );
}

export class ComputerToolSession {
  private selectedCapabilities: ComputerUseCapabilityDescriptor | undefined;
  private selectedCapabilityNodeId: string | undefined;
  private observationState: ComputerObservationState | undefined;
  private computerState: ComputerState = { kind: "unbound" };
  private heldButtonTarget: ComputerTarget | undefined;
  private readonly executionNodes = new Map<string, GatewayCallOptions>();
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      executionId: string;
      idempotencyScope?: string;
      contextEpoch?: ComputerContextEpoch;
      availableActions: (
        actions: readonly ComputerUseV2ActionName[],
      ) => readonly ComputerUseV2ActionName[];
      defaultActions: readonly ComputerUseV2ActionName[];
      onCapabilitiesChanged: (capabilities?: ComputerUseCapabilityDescriptor) => void;
      registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
      getOperationQueue: () => Promise<unknown>;
    },
  ) {
    options.registerRunCleanup?.((reason) => this.dispose(reason));
  }

  private bindNodeCapabilities(node: NodeListNode): void {
    const next = node.computerUse;
    const changed =
      this.selectedCapabilityNodeId !== node.nodeId ||
      this.selectedCapabilities?.provider.generation !== next?.provider.generation;
    this.selectedCapabilityNodeId = node.nodeId;
    this.selectedCapabilities = next;
    this.options.onCapabilitiesChanged(next);
    if (changed) {
      this.observationState = undefined;
    }
  }

  private setComputerState(next: ComputerState): void {
    this.computerState = next;
    if (!this.options.contextEpoch) {
      return;
    }
    if (next.kind !== "frame") {
      delete this.options.contextEpoch.frameToolCallId;
      delete this.options.contextEpoch.frameImageIdentity;
    }
  }

  setTarget(target: ComputerTarget): void {
    this.setComputerState({ kind: "target", target });
  }

  private prepareScreenshotTarget(target: ComputerTarget): void {
    const frame = this.computerState;
    const contextEpoch = this.options.contextEpoch;
    // Retain the visible frame only until replacement pixels are verified; failures clear it.
    if (
      contextEpoch?.frameImageIdentity &&
      frame.kind === "frame" &&
      frame.target.nodeId === target.nodeId &&
      frame.target.screenIndex === target.screenIndex &&
      frame.contextEpoch === contextEpoch.value
    ) {
      return;
    }
    this.setTarget(target);
  }

  refreshUnchangedFrame(params: {
    target: ComputerTarget;
    capture: ScreenshotCapture;
    imageIdentity?: string;
    modelHasVision?: boolean;
  }): ComputerFrame | undefined {
    const frame = this.computerState;
    const contextEpoch = this.options.contextEpoch;
    // Without context tracking, the earlier screenshot may already have been pruned.
    if (
      params.modelHasVision === false ||
      !contextEpoch?.frameImageIdentity ||
      contextEpoch.frameImageIdentity !== params.imageIdentity ||
      frame.kind !== "frame" ||
      frame.target.nodeId !== params.target.nodeId ||
      frame.target.screenIndex !== params.target.screenIndex ||
      frame.contextEpoch !== contextEpoch.value
    ) {
      return undefined;
    }
    // Keep the model's original image/frame binding while refreshing the node's capture token.
    frame.displayFrameId = params.capture.displayFrameId;
    return frame;
  }

  bindDeliveredFrame(params: {
    resolved: ResolvedComputerTarget;
    capture: ScreenshotCapture;
    frameId: string;
    toolCallId: string;
    imageIdentity?: string;
    modelHasVision?: boolean;
  }): void {
    if (params.modelHasVision === false || !params.imageIdentity) {
      this.setTarget(params.resolved.target);
      return;
    }
    this.computerState = {
      kind: "frame",
      target: params.resolved.target,
      id: params.frameId,
      displayFrameId: params.capture.displayFrameId,
      contextEpoch: this.options.contextEpoch?.value ?? 0,
    };
    if (this.options.contextEpoch) {
      this.options.contextEpoch.frameToolCallId = params.toolCallId;
      this.options.contextEpoch.frameImageIdentity = params.imageIdentity;
    }
  }

  recordObservation(resolved: ResolvedComputerTarget, result: ComputerActResult): void {
    const observationId = result.observation?.observationId;
    if (observationId && resolved.capabilities) {
      this.observationState = {
        nodeId: resolved.target.nodeId,
        providerGeneration: resolved.capabilities.provider.generation,
        observationId,
      };
    }
  }

  async resolveTarget(params: {
    action: ComputerToolAction;
    input: Record<string, unknown>;
    gatewayOpts: GatewayCallOptions;
    signal?: AbortSignal;
  }): Promise<ResolvedComputerTarget> {
    const explicitNode = typeof params.input.node === "string" ? params.input.node : undefined;
    const explicitScreenIndex = (() => {
      if (params.input.screenIndex === undefined) {
        return undefined;
      }
      if (
        typeof params.input.screenIndex !== "number" ||
        !Number.isInteger(params.input.screenIndex) ||
        params.input.screenIndex < 0
      ) {
        throw new Error("screenIndex must be a non-negative integer");
      }
      return params.input.screenIndex;
    })();
    const needsFrame = computerActionNeedsFrame(params.action, params.input);
    const priorTarget =
      this.computerState.kind === "unbound" ? undefined : this.computerState.target;
    const implicitTarget = this.heldButtonTarget ?? priorTarget;
    let nodeId: string;
    if (explicitNode !== undefined) {
      const node = await resolveComputerNode(params.gatewayOpts, explicitNode, params.signal);
      nodeId = node.nodeId;
      this.bindNodeCapabilities(node);
    } else if (implicitTarget) {
      nodeId = implicitTarget.nodeId;
    } else {
      const node = await resolveComputerNode(params.gatewayOpts, undefined, params.signal);
      nodeId = node.nodeId;
      this.bindNodeCapabilities(node);
    }
    const capabilities =
      this.selectedCapabilityNodeId === nodeId ? this.selectedCapabilities : undefined;
    this.executionNodes.set(nodeId, params.gatewayOpts);
    const advertisedActions = this.options.availableActions(
      capabilities?.actions ?? this.options.defaultActions,
    );
    if (!advertisedActions.includes(params.action)) {
      throw new Error(
        `${COMPUTER_CONTRACT_MISMATCH}: node ${nodeId} does not advertise action ${params.action}`,
      );
    }
    validateCapabilityBoundInput({
      action: params.action,
      input: params.input,
      nodeId,
      capabilities,
      observationState: this.observationState,
    });
    if (this.heldButtonTarget && nodeId !== this.heldButtonTarget.nodeId) {
      throw new Error(
        `computer: left button may still be held on node ${this.heldButtonTarget.nodeId}; ` +
          "release it before targeting another node",
      );
    }
    if (
      this.heldButtonTarget &&
      explicitScreenIndex !== undefined &&
      explicitScreenIndex !== this.heldButtonTarget.screenIndex
    ) {
      throw new Error(
        `computer: left button may still be held on screen ${this.heldButtonTarget.screenIndex}; ` +
          "release it before targeting another screen",
      );
    }
    const targetForNode = priorTarget?.nodeId === nodeId ? priorTarget : undefined;
    const frame =
      this.computerState.kind === "frame" &&
      this.computerState.target.nodeId === nodeId &&
      this.computerState.contextEpoch === (this.options.contextEpoch?.value ?? 0)
        ? this.computerState
        : undefined;
    if (needsFrame && !frame) {
      throw new Error(
        "computer: no screenshot of this node has been taken yet, so there is no display frame to " +
          "target. Take a `screenshot` first (of this node) before issuing coordinate actions.",
      );
    }
    if (
      needsFrame &&
      explicitScreenIndex !== undefined &&
      explicitScreenIndex !== frame?.target.screenIndex
    ) {
      throw new Error("computer: screenIndex does not match the most recent screenshot frame");
    }
    if (needsFrame && params.input.frameId !== frame?.id) {
      throw new Error(
        "computer: frameId does not match the most recent screenshot result; take a new screenshot",
      );
    }
    const screenIndex =
      explicitScreenIndex ??
      frame?.target.screenIndex ??
      this.heldButtonTarget?.screenIndex ??
      targetForNode?.screenIndex ??
      0;
    return { target: { nodeId, screenIndex }, frame, capabilities };
  }

  async captureScreenshot(
    resolved: ResolvedComputerTarget,
    refWidth: number,
    signal?: AbortSignal,
  ): Promise<ScreenshotCapture> {
    this.prepareScreenshotTarget(resolved.target);
    const commandParams: ScreenSnapshotParams = {
      executionId: this.options.executionId,
      screenIndex: resolved.target.screenIndex,
      maxWidth: refWidth,
      quality: SCREENSHOT_QUALITY,
      format: "jpeg",
    };
    try {
      const payload = await invokeNodeCommand({
        gatewayOpts: this.executionNodes.get(resolved.target.nodeId)!,
        nodeId: resolved.target.nodeId,
        command: SCREEN_SNAPSHOT_COMMAND,
        commandParams,
        signal,
      });
      const parsed = parseScreenSnapshotPayload(payload);
      if (!parsed.displayFrameId) {
        throw new Error(
          "screen.snapshot response missing displayFrameId; update the node app before computer use",
        );
      }
      return {
        base64: parsed.base64,
        displayFrameId: parsed.displayFrameId,
        mimeType: imageMimeFromFormat(parsed.format) ?? "image/jpeg",
        width: parsed.width,
        height: parsed.height,
      };
    } catch (error) {
      this.setTarget(resolved.target);
      throw error;
    }
  }

  async invokeComputerAct(params: {
    resolved: ResolvedComputerTarget;
    wireParams: ComputerActParams;
    toolCallId: string;
    signal?: AbortSignal;
  }): Promise<ComputerActResult> {
    const durationMs =
      "durationMs" in params.wireParams && typeof params.wireParams.durationMs === "number"
        ? params.wireParams.durationMs
        : undefined;
    const invokeTimeoutMs = durationMs ? durationMs + 10_000 : undefined;
    params.signal?.throwIfAborted();
    this.prepareScreenshotTarget(params.resolved.target);
    if (params.wireParams.action === "left_mouse_down") {
      this.heldButtonTarget = params.resolved.target;
    }
    let actResult: ComputerActResult;
    try {
      actResult = parseComputerActPayload(
        await invokeNodeCommand({
          gatewayOpts: this.executionNodes.get(params.resolved.target.nodeId)!,
          nodeId: params.resolved.target.nodeId,
          command: COMPUTER_ACT_COMMAND,
          commandParams: { ...params.wireParams },
          timeoutMs: invokeTimeoutMs,
          idempotencyKey: computerActIdempotencyKey({
            scope: this.options.idempotencyScope,
            toolCallId: params.toolCallId,
          }),
          signal: params.signal,
        }),
      );
    } catch (err) {
      if (params.wireParams.action === "left_mouse_down" && isDefinitiveComputerActRejection(err)) {
        this.heldButtonTarget = undefined;
      }
      if (params.wireParams.action === "left_mouse_up" && isButtonAlreadyReleasedError(err)) {
        this.heldButtonTarget = undefined;
        actResult = { ok: true };
      } else {
        this.setTarget(params.resolved.target);
        throw withComputerEnablementHint(err);
      }
    }
    if (params.wireParams.action === "left_mouse_up") {
      this.heldButtonTarget = undefined;
    }
    return actResult;
  }

  async dispose(reason: string): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }
    this.disposePromise = this.options
      .getOperationQueue()
      .catch(() => {})
      .then(async () => {
        const nodes = [...this.executionNodes.entries()];
        this.executionNodes.clear();
        await Promise.allSettled(
          nodes.map(async ([nodeId, gatewayOpts]) => {
            await invokeNodeCommand({
              gatewayOpts,
              nodeId,
              command: COMPUTER_ACT_COMMAND,
              commandParams: {
                action: "__close_execution",
                executionId: this.options.executionId,
                reason,
              },
              idempotencyKey: `computer.close:${this.options.executionId}:${nodeId}`,
            });
          }),
        );
      });
    return await this.disposePromise;
  }
}
