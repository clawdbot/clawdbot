package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicLong

data class GatewayExecApprovalSummary(
  val id: String,
  val commandText: String,
  val commandPreview: String?,
  val warningText: String?,
  val allowedDecisions: List<String>,
  val host: String?,
  val nodeId: String?,
  val agentId: String?,
  val createdAtMs: Long?,
  val expiresAtMs: Long?,
  val resolvingDecision: String? = null,
  val errorText: String? = null,
)

internal enum class GatewayApprovalTerminalStatus {
  Allowed,
  Denied,
  Expired,
  Cancelled,
}

internal sealed interface GatewayExecApprovalSnapshot {
  val id: String

  data class Pending(
    val summary: GatewayExecApprovalSummary,
  ) : GatewayExecApprovalSnapshot {
    override val id: String = summary.id
  }

  data class Terminal(
    override val id: String,
    val status: GatewayApprovalTerminalStatus,
    val decision: String?,
  ) : GatewayExecApprovalSnapshot
}

internal data class GatewayExecApprovalResolution(
  val applied: Boolean,
  val approval: GatewayExecApprovalSnapshot.Terminal,
  val attribution: GatewayExecApprovalResolutionAttribution =
    if (applied) GatewayExecApprovalResolutionAttribution.AppliedHere else GatewayExecApprovalResolutionAttribution.PriorResponse,
)

internal enum class GatewayExecApprovalResolutionAttribution {
  AppliedHere,
  PriorResponse,
  Unknown,
}

private val execApprovalNoticePublications = AtomicLong()

data class GatewayExecApprovalNotice(
  val approvalId: String,
  val message: String,
  val warning: Boolean,
  // Distinct per constructed notice: a re-requested approval can lose again with an
  // identical id/message, and the dismiss compareAndSet must not treat the stale
  // banner as equal to its replacement.
  val publication: Long = execApprovalNoticePublications.incrementAndGet(),
)

internal fun gatewayExecApprovalResolutionNotice(
  resolution: GatewayExecApprovalResolution,
): GatewayExecApprovalNotice =
  when (resolution.approval.status) {
    GatewayApprovalTerminalStatus.Allowed -> {
      val saved = resolution.approval.decision == "allow-always"
      GatewayExecApprovalNotice(
        approvalId = resolution.approval.id,
        message = gatewayExecApprovalAllowedMessage(attribution = resolution.attribution, saved = saved),
        warning = false,
      )
    }
    GatewayApprovalTerminalStatus.Denied ->
      GatewayExecApprovalNotice(
        approvalId = resolution.approval.id,
        message = gatewayExecApprovalDeniedMessage(resolution.attribution),
        warning = true,
      )
    GatewayApprovalTerminalStatus.Expired ->
      GatewayExecApprovalNotice(
        approvalId = resolution.approval.id,
        message = gatewayExecApprovalTerminalMessage(resolution.approval.status),
        warning = true,
      )
    GatewayApprovalTerminalStatus.Cancelled ->
      GatewayExecApprovalNotice(
        approvalId = resolution.approval.id,
        message = gatewayExecApprovalTerminalMessage(resolution.approval.status),
        warning = true,
      )
  }

private fun gatewayExecApprovalAllowedMessage(
  attribution: GatewayExecApprovalResolutionAttribution,
  saved: Boolean,
): String {
  if (attribution == GatewayExecApprovalResolutionAttribution.AppliedHere) {
    if (saved) return "Approval allowed and saved."
    return "Approval allowed once."
  }
  if (attribution == GatewayExecApprovalResolutionAttribution.PriorResponse) {
    if (saved) return "A prior response already allowed this command and saved the choice."
    return "A prior response already allowed this command once."
  }
  if (saved) return "Gateway recorded approval and saved the choice."
  return "Gateway recorded approval once."
}

private fun gatewayExecApprovalDeniedMessage(attribution: GatewayExecApprovalResolutionAttribution): String =
  when (attribution) {
    GatewayExecApprovalResolutionAttribution.AppliedHere -> "Approval denied."
    GatewayExecApprovalResolutionAttribution.PriorResponse -> "A prior response already denied this approval."
    GatewayExecApprovalResolutionAttribution.Unknown -> "Gateway recorded a denial."
  }

private fun gatewayExecApprovalTerminalMessage(status: GatewayApprovalTerminalStatus): String =
  when (status) {
    GatewayApprovalTerminalStatus.Expired -> "This approval expired before it could be resolved."
    GatewayApprovalTerminalStatus.Cancelled -> "This approval was cancelled before it could be resolved."
    else -> error("approval is not expired or cancelled")
  }

internal fun gatewayExecApprovalRemoteTerminalNotice(
  approval: GatewayExecApprovalSnapshot.Terminal,
): GatewayExecApprovalNotice =
  gatewayExecApprovalResolutionNotice(
    GatewayExecApprovalResolution(applied = false, approval = approval),
  )

internal fun gatewayExecApprovalPriorResolutionNotice(id: String): GatewayExecApprovalNotice =
  GatewayExecApprovalNotice(
    approvalId = id,
    message = gatewayExecApprovalPriorResolutionMessage(),
    warning = true,
  )

private fun gatewayExecApprovalPriorResolutionMessage(): String = "A prior response already resolved this approval."

internal fun normalizeGatewayExecApprovalDecision(value: String): String? =
  when (value) {
    "allow-once" -> "allow-once"
    "allow-always" -> "allow-always"
    "deny" -> "deny"
    else -> null
  }

/** Parses the terminal winner from an authenticated Gateway resolution event. */
internal fun parseGatewayExecApprovalResolvedEventTerminal(
  payloadJson: String,
  json: Json,
): GatewayExecApprovalSnapshot.Terminal? =
  try {
    val root = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return null
    val id = root.strictApprovalId("id") ?: return null
    val decision = root.strictString("decision")?.let(::normalizeGatewayExecApprovalDecision) ?: return null
    legacyGatewayExecApprovalTerminal(id, decision)
  } catch (_: Throwable) {
    null
  }

internal enum class GatewayApprovalRpcFamily {
  Canonical,
  Legacy,
  Unavailable,
}

/**
 * Selects one read/write family for the lifetime of a Gateway hello catalog.
 * Legacy exec.approval.* serves shipped Gateway v4 peers until the minimum supported
 * Gateway advertises approval.get/approval.resolve.
 */
internal fun selectGatewayApprovalRpcFamily(methods: Set<String>): GatewayApprovalRpcFamily {
  val hasCanonicalGet = "approval.get" in methods
  val hasCanonicalResolve = "approval.resolve" in methods
  if (hasCanonicalGet && hasCanonicalResolve) return GatewayApprovalRpcFamily.Canonical
  if (
    !hasCanonicalGet &&
    !hasCanonicalResolve &&
    "exec.approval.get" in methods &&
    "exec.approval.resolve" in methods
  ) {
    return GatewayApprovalRpcFamily.Legacy
  }
  return GatewayApprovalRpcFamily.Unavailable
}

internal fun buildGatewayExecApprovalGetParams(id: String): JsonObject = buildJsonObject { put("id", id) }

internal fun buildGatewayExecApprovalResolveParams(
  id: String,
  decision: String,
): JsonObject =
  buildJsonObject {
    put("id", id)
    put("kind", "exec")
    put("decision", decision)
  }

internal fun parseGatewayExecApprovalListPayload(
  payloadJson: String,
  json: Json,
): List<GatewayExecApprovalSummary> =
  try {
    (json.parseToJsonElement(payloadJson) as? JsonArray)
      ?.mapNotNull(::parseGatewayExecApprovalListEntry)
      ?.sortedBy { it.createdAtMs ?: Long.MAX_VALUE }
      .orEmpty()
  } catch (_: Throwable) {
    emptyList()
  }

internal fun parseGatewayExecApprovalListEntry(item: JsonElement): GatewayExecApprovalSummary? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj.strictApprovalId("id") ?: return null
  val createdAtMs = obj.strictNonNegativeLong("createdAtMs") ?: return null
  val expiresAtMs = obj.strictNonNegativeLong("expiresAtMs") ?: return null
  // The legacy list is discovery-only. Its embedded request can contain runtime-only
  // details, so rendering waits for the reviewer-safe unified approval projection.
  return GatewayExecApprovalSummary(
    id = id,
    commandText = gatewayExecApprovalCommandRequestText(),
    commandPreview = null,
    warningText = null,
    allowedDecisions = emptyList(),
    host = null,
    nodeId = null,
    agentId = null,
    createdAtMs = createdAtMs,
    expiresAtMs = expiresAtMs,
  )
}

private fun gatewayExecApprovalCommandRequestText(): String = "Command request"

internal fun parseGatewayExecApprovalGetPayload(
  payloadJson: String,
  json: Json,
  expectedId: String,
): GatewayExecApprovalSnapshot? =
  try {
    val root = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return null
    if (!root.hasExactKeys(APPROVAL_GET_RESULT_KEYS)) return null
    parseGatewayExecApprovalSnapshot(root["approval"].asObjectOrNull() ?: return null)
      ?.takeIf { it.id == expectedId }
  } catch (_: Throwable) {
    null
  }

internal fun parseGatewayExecApprovalResolvePayload(
  payloadJson: String,
  json: Json,
  expectedId: String,
  expectedDecision: String,
): GatewayExecApprovalResolution? =
  try {
    val root = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return null
    if (!root.hasExactKeys(APPROVAL_RESOLVE_RESULT_KEYS)) return null
    val applied = root.strictBoolean("applied") ?: return null
    val approval =
      parseGatewayExecApprovalSnapshot(root["approval"].asObjectOrNull() ?: return null)
        as? GatewayExecApprovalSnapshot.Terminal
        ?: return null
    if (approval.id != expectedId) return null
    // `applied=true` claims this write won. A different returned decision is an
    // ambiguous write outcome, never evidence that the attempted approval applied.
    if (applied && approval.decision != expectedDecision) return null
    GatewayExecApprovalResolution(applied = applied, approval = approval)
  } catch (_: Throwable) {
    null
  }

/** Parses the shipped pre-unified exec reviewer projection for old Gateway v4 peers. */
internal fun parseLegacyGatewayExecApprovalGetPayload(
  payloadJson: String,
  json: Json,
  expectedId: String,
  createdAtMs: Long?,
): GatewayExecApprovalSnapshot.Pending? =
  try {
    val obj = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return null
    val id = obj.strictApprovalId("id") ?: return null
    if (id != expectedId) return null
    val normalizedCreatedAtMs = createdAtMs?.takeIf { it >= 0 } ?: return null
    val expiresAtMs = obj.strictNonNegativeLong("expiresAtMs") ?: return null
    val commandText = obj.strictNonEmptyString("commandText") ?: return null
    val commandPreview = obj.optionalString("commandPreview") ?: return null
    val host = obj.optionalString("host") ?: return null
    val nodeId = obj.optionalString("nodeId", requireNonEmpty = true) ?: return null
    val agentId = obj.optionalString("agentId", requireNonEmpty = true) ?: return null
    val allowedDecisions = parseAllowedDecisions(obj["allowedDecisions"] as? JsonArray) ?: return null
    GatewayExecApprovalSnapshot.Pending(
      GatewayExecApprovalSummary(
        id = id,
        commandText = commandText,
        commandPreview = commandPreview.value?.takeIf { it != commandText },
        warningText = null,
        allowedDecisions = allowedDecisions,
        host = host.value,
        nodeId = nodeId.value,
        agentId = agentId.value,
        createdAtMs = normalizedCreatedAtMs,
        expiresAtMs = expiresAtMs,
      ),
    )
  } catch (_: Throwable) {
    null
  }

internal fun parseLegacyGatewayExecApprovalResolvePayload(
  payloadJson: String,
  json: Json,
): Boolean =
  try {
    val root = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return false
    root.strictBoolean("ok") == true
  } catch (_: Throwable) {
    false
  }

internal fun legacyGatewayExecApprovalTerminal(
  id: String,
  decision: String,
): GatewayExecApprovalSnapshot.Terminal? {
  val status =
    when (decision) {
      "allow-once", "allow-always" -> GatewayApprovalTerminalStatus.Allowed
      "deny" -> GatewayApprovalTerminalStatus.Denied
      else -> return null
    }
  return GatewayExecApprovalSnapshot.Terminal(id, status, decision)
}

private fun parseGatewayExecApprovalSnapshot(obj: JsonObject): GatewayExecApprovalSnapshot? {
  val status = obj.strictString("status") ?: return null
  val expectedKeys = APPROVAL_SNAPSHOT_KEYS_BY_STATUS[status] ?: return null
  if (!obj.hasExactKeys(expectedKeys)) return null
  val id = obj.strictApprovalId("id") ?: return null
  obj.strictNonEmptyString("urlPath") ?: return null
  val createdAtMs = obj.strictNonNegativeLong("createdAtMs") ?: return null
  val expiresAtMs = obj.strictNonNegativeLong("expiresAtMs") ?: return null
  val presentation = obj["presentation"].asObjectOrNull() ?: return null
  val summary = parseGatewayExecApprovalPresentation(id, createdAtMs, expiresAtMs, presentation) ?: return null
  return when (status) {
    "pending" -> GatewayExecApprovalSnapshot.Pending(summary)
    "allowed" ->
      parseTerminalApproval(
        obj = obj,
        id = id,
        status = GatewayApprovalTerminalStatus.Allowed,
        expectedDecision = setOf("allow-once", "allow-always"),
      )?.takeIf { terminal ->
        terminal.decision?.let(summary.allowedDecisions::contains) == true
      }
    "denied" ->
      parseTerminalApproval(
        obj = obj,
        id = id,
        status = GatewayApprovalTerminalStatus.Denied,
        expectedDecision = setOf("deny"),
      )
    "expired" ->
      parseTerminalApproval(
        obj = obj,
        id = id,
        status = GatewayApprovalTerminalStatus.Expired,
        expectedDecision = null,
      )
    "cancelled" ->
      parseTerminalApproval(
        obj = obj,
        id = id,
        status = GatewayApprovalTerminalStatus.Cancelled,
        expectedDecision = null,
      )
    else -> null
  }
}

private fun parseGatewayExecApprovalPresentation(
  id: String,
  createdAtMs: Long,
  expiresAtMs: Long,
  presentation: JsonObject,
): GatewayExecApprovalSummary? {
  if (!presentation.hasOnlyKeys(EXEC_APPROVAL_PRESENTATION_KEYS)) return null
  if (!presentation.keys.containsAll(EXEC_APPROVAL_PRESENTATION_REQUIRED_KEYS)) return null
  // A unified lookup can return other approval owners. Android's exec inbox must
  // never reinterpret plugin copy or metadata as an executable command request.
  if (presentation.strictString("kind") != "exec") return null
  val commandText = presentation.strictNonEmptyString("commandText") ?: return null
  val allowedDecisions = parseAllowedDecisions(presentation["allowedDecisions"] as? JsonArray) ?: return null
  val commandPreview = presentation.optionalString("commandPreview") ?: return null
  val warningText = presentation.optionalString("warningText") ?: return null
  val host = presentation.optionalString("host") ?: return null
  val nodeId = presentation.optionalString("nodeId", requireNonEmpty = true) ?: return null
  val agentId = presentation.optionalString("agentId", requireNonEmpty = true) ?: return null
  return GatewayExecApprovalSummary(
    id = id,
    commandText = commandText,
    commandPreview = commandPreview.value?.takeIf { it != commandText },
    warningText = warningText.value,
    allowedDecisions = allowedDecisions,
    host = host.value,
    nodeId = nodeId.value,
    agentId = agentId.value,
    createdAtMs = createdAtMs,
    expiresAtMs = expiresAtMs,
  )
}

private fun parseTerminalApproval(
  obj: JsonObject,
  id: String,
  status: GatewayApprovalTerminalStatus,
  expectedDecision: Set<String>?,
): GatewayExecApprovalSnapshot.Terminal? {
  obj.strictNonNegativeLong("resolvedAtMs") ?: return null
  val reason = obj.strictString("reason") ?: return null
  if (reason !in APPROVAL_TERMINAL_REASONS) return null
  val decision = obj.strictString("decision")
  if (expectedDecision == null) {
    if (obj.containsKey("decision")) return null
  } else if (decision !in expectedDecision) {
    return null
  }
  return GatewayExecApprovalSnapshot.Terminal(id = id, status = status, decision = decision)
}

private fun parseAllowedDecisions(items: JsonArray?): List<String>? {
  if (items == null || items.size !in 1..3) return null
  val decisions = items.map { item -> item.strictString() ?: return null }
  if (decisions.distinct().size != decisions.size || "deny" !in decisions) return null
  return decisions.takeIf { values -> values.all { it in APPROVAL_DECISIONS } }
}

private data class OptionalString(
  val value: String?,
)

private fun JsonObject.optionalString(
  key: String,
  requireNonEmpty: Boolean = false,
): OptionalString? {
  val value = this[key]
  if (value == null || value is JsonNull) return OptionalString(null)
  val string = value.strictString() ?: return null
  if (requireNonEmpty && string.isEmpty()) return null
  return OptionalString(string)
}

private fun JsonObject.strictString(key: String): String? = this[key].strictString()

private fun JsonElement?.strictString(): String? =
  (this as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.content

private fun JsonObject.strictNonEmptyString(key: String): String? =
  strictString(key)
    ?.takeIf { it.isNotEmpty() }

private fun JsonObject.strictApprovalId(key: String): String? =
  strictString(key)
    ?.takeIf(::isWellFormedGatewayApprovalId)

private fun JsonObject.strictBoolean(key: String): Boolean? =
  (this[key] as? JsonPrimitive)
    ?.takeUnless { it.isString }
    ?.booleanOrNull

private fun JsonObject.strictNonNegativeLong(key: String): Long? =
  (this[key] as? JsonPrimitive)
    ?.takeUnless { it.isString }
    ?.longOrNull
    ?.takeIf { it >= 0 }

// Closed-schema contract: the gateway protocol declares approval results with
// additionalProperties:false, so additive protocol changes hard-fail old clients by design.
private fun JsonObject.hasExactKeys(expected: Set<String>): Boolean = keys == expected

private fun JsonObject.hasOnlyKeys(allowed: Set<String>): Boolean = keys.all(allowed::contains)

internal fun isWellFormedGatewayApprovalId(value: String): Boolean {
  if (value.isEmpty() || value == "." || value == "..") return false
  var index = 0
  while (index < value.length) {
    val current = value[index]
    when {
      Character.isHighSurrogate(current) -> {
        if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) return false
        index += 2
      }
      Character.isLowSurrogate(current) -> return false
      else -> index += 1
    }
  }
  return true
}

private val APPROVAL_GET_RESULT_KEYS = setOf("approval")

private val APPROVAL_RESOLVE_RESULT_KEYS = setOf("applied", "approval")

private val APPROVAL_SNAPSHOT_COMMON_KEYS =
  setOf("id", "urlPath", "status", "createdAtMs", "expiresAtMs", "presentation")

private val APPROVAL_SNAPSHOT_KEYS_BY_STATUS =
  mapOf(
    "pending" to APPROVAL_SNAPSHOT_COMMON_KEYS,
    "allowed" to APPROVAL_SNAPSHOT_COMMON_KEYS + setOf("resolvedAtMs", "reason", "decision"),
    "denied" to APPROVAL_SNAPSHOT_COMMON_KEYS + setOf("resolvedAtMs", "reason", "decision"),
    "expired" to APPROVAL_SNAPSHOT_COMMON_KEYS + setOf("resolvedAtMs", "reason"),
    "cancelled" to APPROVAL_SNAPSHOT_COMMON_KEYS + setOf("resolvedAtMs", "reason"),
  )

private val EXEC_APPROVAL_PRESENTATION_REQUIRED_KEYS = setOf("kind", "commandText", "allowedDecisions")

private val EXEC_APPROVAL_PRESENTATION_KEYS =
  EXEC_APPROVAL_PRESENTATION_REQUIRED_KEYS +
    setOf("commandPreview", "warningText", "host", "nodeId", "agentId")

private val APPROVAL_DECISIONS = setOf("allow-once", "allow-always", "deny")

private val APPROVAL_TERMINAL_REASONS =
  setOf(
    "user",
    "timeout",
    "malformed-verdict",
    "no-route",
    "run-aborted",
    "gateway-restart",
    "storage-corrupt",
  )
