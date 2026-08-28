package ai.openclaw.app

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

internal const val CLAWHUB_INSTALL_REQUEST_TIMEOUT_MS = 125_000L
internal const val CLAWHUB_SKILL_GATEWAY_UNAVAILABLE = "Update the Gateway to search and install ClawHub skills from Android."
internal val CLAWHUB_SKILL_GATEWAY_METHODS = setOf("skills.search", "skills.detail", "skills.install")
internal const val CLAWHUB_UNSCANNED_TRUST_STATE = "not-scanned-by-clawhub"

data class GatewayClawHubSkillSearchState(
  val query: String = "",
  val searching: Boolean = false,
  val results: List<GatewayClawHubSkillSummary> = emptyList(),
  val reviewingSlug: String? = null,
  val installReview: GatewayClawHubInstallReview? = null,
  val installingSlugs: Set<String> = emptySet(),
  val errorText: String? = null,
  val messageText: String? = null,
)

data class GatewayClawHubSkillSummary(
  val slug: String,
  val installRef: String?,
  val installOnly: Boolean?,
  val trustState: String?,
  val displayName: String,
  val summary: String?,
  val version: String?,
) {
  /**
   * Several publishers can share one slug, so the Gateway-supplied reference is what identifies a
   * result, what distinguishes rows, and what install must send back. It names the result's own
   * source, so it is never rebuilt from owner and slug.
   */
  val reference: String
    get() = installRef?.trim()?.takeIf(String::isNotEmpty) ?: slug

  /**
   * Drives the affordance, so no client has to recognize external reference spellings itself.
   * Only an explicit install-only result skips review: a Gateway that predates this field omits
   * it, and those results must keep the reviewed-version flow they have always used.
   */
  val canReadDetails: Boolean
    get() = installOnly != true

  val isUnscannedSource: Boolean
    get() = trustState == CLAWHUB_UNSCANNED_TRUST_STATE
}

data class GatewayClawHubInstallReview(
  val slug: String,
  val displayName: String,
  val summary: String?,
  val version: String,
  val author: String,
)

internal data class GatewayClawHubInstallRejection(
  val message: String,
  val warning: String?,
)

internal fun parseClawHubSearchResults(
  raw: String,
  json: Json,
): List<GatewayClawHubSkillSummary> {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return emptyList()
  return (root["results"] as? JsonArray)
    ?.mapNotNull { item ->
      val value = item as? JsonObject ?: return@mapNotNull null
      val slug = value.string("slug") ?: return@mapNotNull null
      val displayName = value.string("displayName") ?: return@mapNotNull null
      GatewayClawHubSkillSummary(
        slug = slug,
        installRef = value.string("installRef"),
        installOnly = (value["installOnly"] as? JsonPrimitive)?.booleanOrNull,
        trustState = value.string("trustState"),
        displayName = displayName,
        summary = value.string("summary"),
        version = value.string("version"),
      )
    }.orEmpty()
}

internal fun parseClawHubInstallReview(
  raw: String,
  fallback: GatewayClawHubSkillSummary,
  json: Json,
): GatewayClawHubInstallReview? {
  val root = json.parseToJsonElement(raw) as? JsonObject ?: return null
  val skill = root["skill"] as? JsonObject
  val latestVersion = root["latestVersion"] as? JsonObject
  val owner = root["owner"] as? JsonObject
  // The detail response is the install review boundary. Prefer its current
  // version over the potentially stale search result shown before review.
  val version = latestVersion?.string("version") ?: fallback.version ?: return null
  val ownerDisplayName = owner?.string("displayName")
  val ownerHandle = owner?.string("handle")
  val reviewedSlug =
    canonicalClawHubSkillReference(
      slug = skill?.string("slug") ?: fallback.slug,
      ownerHandle = ownerHandle,
    ) ?: return null
  val author =
    when {
      ownerDisplayName != null && ownerHandle != null && !ownerDisplayName.equals(ownerHandle, ignoreCase = true) ->
        "$ownerDisplayName (@$ownerHandle)"
      ownerDisplayName != null -> ownerDisplayName
      ownerHandle != null -> "@$ownerHandle"
      else -> "Unknown publisher"
    }
  return GatewayClawHubInstallReview(
    slug = reviewedSlug,
    displayName = skill?.string("displayName") ?: fallback.displayName,
    summary = skill?.string("summary") ?: fallback.summary,
    version = version,
    author = author,
  )
}

internal fun clawHubInstallRejection(error: GatewaySession.ErrorShape): GatewayClawHubInstallRejection =
  GatewayClawHubInstallRejection(
    message = error.message.ifBlank { "The Gateway rejected this ClawHub install." },
    warning =
      error.details
        ?.clawhubWarning
        ?.trim()
        ?.takeIf(String::isNotEmpty),
  )

internal fun supportsClawHubSkillManagement(methods: Set<String>): Boolean = methods.containsAll(CLAWHUB_SKILL_GATEWAY_METHODS)

internal fun clawHubSearchParams(query: String): String =
  buildJsonObject {
    query.trim().takeIf(String::isNotEmpty)?.let { put("query", JsonPrimitive(it)) }
    put("limit", JsonPrimitive(25))
  }.toString()

internal fun clawHubDetailParams(slug: String): String = buildJsonObject { put("slug", JsonPrimitive(slug)) }.toString()

internal fun clawHubInstallParams(
  slug: String,
  version: String?,
): String =
  buildJsonObject {
    put("source", JsonPrimitive("clawhub"))
    put("slug", JsonPrimitive(slug))
    version?.trim()?.takeIf(String::isNotEmpty)?.let { put("version", JsonPrimitive(it)) }
    put("timeoutMs", JsonPrimitive(120_000))
  }.toString()

internal fun skillEnabledParams(
  skillKey: String,
  enabled: Boolean,
): String =
  buildJsonObject {
    put("skillKey", JsonPrimitive(skillKey))
    put("enabled", JsonPrimitive(enabled))
  }.toString()

internal fun formatClawHubInstallMessage(
  message: String,
  warning: String?,
): String = if (warning.isNullOrBlank()) message else "$message\n\n$warning"

internal fun isClawHubSkillInstalled(
  skills: List<GatewaySkillSummary>,
  slug: String,
): Boolean {
  val reference = parseClawHubSkillReference(slug) ?: return false
  return skills.any { it.matchesClawHubReference(reference) }
}

internal fun isClawHubSkillInstalled(
  skills: List<GatewaySkillSummary>,
  searchResult: GatewayClawHubSkillSummary,
): Boolean =
  if (!searchResult.canReadDetails) {
    isClawHubSkillInstalledByReference(skills, searchResult.reference)
  } else {
    searchResult.version?.let { version ->
      isClawHubSkillInstalled(skills, searchResult.reference, version)
    } ?: isClawHubSkillInstalled(skills, searchResult.reference)
  }

/**
 * Readback for an install-only source. Its reference is not a `@owner/slug` spelling, so the slug
 * comparison never matches it; the Gateway records the exact reference instead.
 */
internal fun isClawHubSkillInstalledByReference(
  skills: List<GatewaySkillSummary>,
  requestedReference: String,
): Boolean {
  val reference = requestedReference.trim()
  if (reference.isEmpty()) return false
  return skills.any { it.clawHubValid && it.clawHubRequestedReference == reference }
}

internal fun isClawHubSkillInstalled(
  skills: List<GatewaySkillSummary>,
  slug: String,
  version: String,
): Boolean =
  parseClawHubSkillReference(slug)?.let { reference ->
    skills.any { it.matchesClawHubReference(reference) && it.clawHubInstalledVersion == version }
  } ?: false

internal fun isClawHubSkillOperationActive(
  activeSlugs: Set<String>,
  slug: String,
): Boolean {
  val reference = parseClawHubSkillReference(slug) ?: return false
  return activeSlugs.any { activeSlug ->
    val active = parseClawHubSkillReference(activeSlug) ?: return@any false
    active.slug.equals(reference.slug, ignoreCase = true) &&
      (
        active.ownerHandle == null ||
          reference.ownerHandle == null ||
          active.ownerHandle.equals(reference.ownerHandle, ignoreCase = true)
      )
  }
}

private data class ClawHubSkillReference(
  val slug: String,
  val ownerHandle: String?,
)

private fun parseClawHubSkillReference(rawValue: String): ClawHubSkillReference? {
  val value = rawValue.trim()
  if (value.isEmpty()) return null
  if (!value.startsWith("@")) return ClawHubSkillReference(value, null)
  val parts = value.drop(1).split("/")
  if (parts.size != 2 || parts.any(String::isEmpty)) return null
  return ClawHubSkillReference(slug = parts[1], ownerHandle = parts[0].lowercase())
}

private fun canonicalClawHubSkillReference(
  slug: String,
  ownerHandle: String?,
): String? {
  val reference = parseClawHubSkillReference(slug) ?: return null
  val owner = ownerHandle?.trim()?.takeIf(String::isNotEmpty)?.lowercase() ?: reference.ownerHandle
  return owner?.let { "@$it/${reference.slug}" } ?: reference.slug
}

private fun GatewaySkillSummary.matchesClawHubReference(reference: ClawHubSkillReference): Boolean {
  if (!clawHubValid) return false
  val installedReference = clawHubSlug?.let(::parseClawHubSkillReference) ?: return false
  if (!installedReference.slug.equals(reference.slug, ignoreCase = true)) return false
  val requestedOwner = reference.ownerHandle ?: return true
  val installedOwner = installedReference.ownerHandle ?: clawHubOwnerHandle
  return installedOwner?.equals(requestedOwner, ignoreCase = true) == true
}

internal fun clawHubInstallOutcomeUnknownMessage(slug: String): String = "The result for $slug is unknown. Reconnect, refresh Skills, then retry; the Gateway safely joins a matching install that is still running."

private fun JsonObject.string(key: String): String? =
  (get(key) as? JsonPrimitive)
    ?.contentOrNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
