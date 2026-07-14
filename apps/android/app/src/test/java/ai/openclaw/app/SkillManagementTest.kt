package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayConnectErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SkillManagementTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun searchResultsKeepOnlyIdentifiedSkills() {
    val results =
      parseClawHubSearchResults(
        """{"results":[{"slug":" alpha ","displayName":"Alpha","summary":"Useful","version":"1.2.3"},{"slug":"missing-name"},{"displayName":"Missing slug"}]}""",
        json,
      )

    assertEquals(
      listOf(
        GatewayClawHubSkillSummary(
          slug = "alpha",
          displayName = "Alpha",
          summary = "Useful",
          version = "1.2.3",
        ),
      ),
      results,
    )
  }

  @Test
  fun detailBindsExactVersionAndPublisherIdentity() {
    val review =
      parseClawHubInstallReview(
        """{"skill":{"displayName":"Alpha Skill","summary":"Reviewed metadata"},"latestVersion":{"version":"2.0.0"},"owner":{"displayName":"Alice","handle":"alice"}}""",
        GatewayClawHubSkillSummary("alpha", "Alpha", null, null),
        json,
      )

    assertEquals(
      GatewayClawHubInstallReview(
        slug = "@alice/alpha",
        displayName = "Alpha Skill",
        summary = "Reviewed metadata",
        version = "2.0.0",
        author = "Alice",
      ),
      review,
    )
  }

  @Test
  fun detailVersionWinsWhenSearchResultIsStale() {
    val review =
      parseClawHubInstallReview(
        """{"skill":{"displayName":"Alpha"},"latestVersion":{"version":"2.0.0"},"owner":{"handle":"alice"}}""",
        GatewayClawHubSkillSummary("alpha", "Alpha", null, "1.9.0"),
        json,
      )

    assertEquals("2.0.0", review?.version)
  }

  @Test
  fun detailFailsClosedWithoutAnInstallableVersion() {
    val review =
      parseClawHubInstallReview(
        """{"skill":{"displayName":"Alpha"},"owner":{"handle":"alice"}}""",
        GatewayClawHubSkillSummary("alpha", "Alpha", null, null),
        json,
      )

    assertNull(review)
  }

  @Test
  fun installParamsKeepRegistryAndTrustPolicyOnGateway() {
    val params = json.parseToJsonElement(clawHubInstallParams("alpha", "1.2.3", acknowledgeRisk = true)).jsonObject

    assertEquals(setOf("source", "slug", "version", "acknowledgeClawHubRisk", "timeoutMs"), params.keys)
    assertEquals("clawhub", params.getValue("source").jsonPrimitive.content)
    assertEquals("alpha", params.getValue("slug").jsonPrimitive.content)
    assertEquals("1.2.3", params.getValue("version").jsonPrimitive.content)
    assertTrue(params.getValue("acknowledgeClawHubRisk").jsonPrimitive.boolean)
    assertEquals(120_000, params.getValue("timeoutMs").jsonPrimitive.int)
  }

  @Test
  fun onlyStructuredReviewRequiredFailureOffersAcknowledgement() {
    val rejection =
      clawHubInstallRejection(
        GatewaySession.ErrorShape(
          code = "UNAVAILABLE",
          message = "review required",
          details =
            GatewayConnectErrorDetails(
              code = null,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
              clawhubTrustCode = "clawhub_risk_acknowledgement_required",
              clawhubWarning = "Scanner found elevated permissions.",
              clawhubVersion = "1.2.3",
            ),
        ),
        attemptedVersion = "1.2.3",
      )

    assertTrue(rejection.requiresAcknowledgement)
    assertEquals("1.2.3", rejection.acknowledgeVersion)
    assertEquals("Scanner found elevated permissions.", rejection.warning)
  }

  @Test
  fun changedGatewayVersionRequiresFreshReview() {
    val rejection =
      clawHubInstallRejection(
        GatewaySession.ErrorShape(
          code = "UNAVAILABLE",
          message = "review required",
          details =
            GatewayConnectErrorDetails(
              code = null,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
              clawhubTrustCode = "clawhub_risk_acknowledgement_required",
              clawhubWarning = "Scanner found elevated permissions.",
              clawhubVersion = "1.2.4",
            ),
        ),
        attemptedVersion = "1.2.3",
      )

    assertFalse(rejection.requiresAcknowledgement)
    assertNull(rejection.acknowledgeVersion)
    assertTrue(rejection.message.contains("different ClawHub release"))
  }

  @Test
  fun blockedFailureNeverOffersAcknowledgement() {
    val rejection =
      clawHubInstallRejection(
        GatewaySession.ErrorShape(
          code = "UNAVAILABLE",
          message = "download blocked",
          details =
            GatewayConnectErrorDetails(
              code = null,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
              clawhubTrustCode = "clawhub_download_blocked",
              clawhubWarning = "ClawHub marked this release malicious.",
              clawhubVersion = "1.2.3",
            ),
        ),
        attemptedVersion = "1.2.3",
      )

    assertFalse(rejection.requiresAcknowledgement)
    assertNull(rejection.acknowledgeVersion)
  }

  @Test
  fun unknownInstallReadbackUsesClawHubProvenanceSlug() {
    val skill =
      GatewaySkillSummary(
        skillKey = "custom-frontmatter-key",
        name = "Custom display name",
        description = null,
        source = "openclaw-managed",
        emoji = null,
        disabled = false,
        eligible = true,
        blockedByAllowlist = false,
        blockedByAgentFilter = false,
        bundled = false,
        missingCount = 0,
        installCount = 0,
        clawHubSlug = "registry-slug",
        clawHubValid = true,
        clawHubOwnerHandle = "registry-owner",
        clawHubInstalledVersion = "1.2.3",
      )

    assertTrue(isClawHubSkillInstalled(listOf(skill), "registry-slug", "1.2.3"))
    assertTrue(isClawHubSkillInstalled(listOf(skill), "registry-slug"))
    assertTrue(isClawHubSkillInstalled(listOf(skill), "@registry-owner/registry-slug", "1.2.3"))
    assertFalse(isClawHubSkillInstalled(listOf(skill), "@other-owner/registry-slug", "1.2.3"))
    assertFalse(isClawHubSkillInstalled(listOf(skill), "registry-slug", "1.2.4"))
    assertFalse(isClawHubSkillInstalled(listOf(skill.copy(clawHubValid = false)), "registry-slug", "1.2.3"))
    assertFalse(isClawHubSkillInstalled(listOf(skill), "custom-frontmatter-key", "1.2.3"))
  }

  @Test
  fun ownerQualifiedInstallStaysActiveForBrowseSlug() {
    assertTrue(isClawHubSkillOperationActive(setOf("@registry-owner/registry-slug"), "registry-slug"))
    assertTrue(
      isClawHubSkillOperationActive(
        setOf("@registry-owner/registry-slug"),
        "@registry-owner/registry-slug",
      ),
    )
    assertFalse(
      isClawHubSkillOperationActive(
        setOf("@other-owner/registry-slug"),
        "@registry-owner/registry-slug",
      ),
    )
  }

  @Test
  fun clawHubManagementRequiresEveryAdvertisedMethod() {
    assertTrue(supportsClawHubSkillManagement(CLAWHUB_SKILL_GATEWAY_METHODS))
    assertFalse(supportsClawHubSkillManagement(CLAWHUB_SKILL_GATEWAY_METHODS - "skills.detail"))
  }
}
