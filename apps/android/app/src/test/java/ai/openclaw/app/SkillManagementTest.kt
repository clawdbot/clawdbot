package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
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
        """{"results":[{"slug":" alpha ","installRef":"@alice/alpha","displayName":"Alpha","summary":"Useful","version":"1.2.3"},{"slug":"missing-name"},{"displayName":"Missing slug"}]}""",
        json,
      )

    assertEquals(
      listOf(
        GatewayClawHubSkillSummary(
          slug = "alpha",
          installRef = "@alice/alpha",
          installOnly = null,
          trustState = null,
          displayName = "Alpha",
          summary = "Useful",
          version = "1.2.3",
        ),
      ),
      results,
    )
  }

  @Test
  fun sameSlugResultsKeepSeparatePublisherReferences() {
    val results =
      parseClawHubSearchResults(
        """{"results":[{"slug":"email","installRef":"@alice/email","displayName":"Email"},{"slug":"email","installRef":"@bob/email","displayName":"Email"},{"slug":"orphan","displayName":"Orphan"}]}""",
        json,
      )

    assertEquals(listOf("@alice/email", "@bob/email", "orphan"), results.map { it.reference })
  }

  @Test
  fun installOnlyResultsKeepTheirSourceAndExposeNoDetailAction() {
    val results =
      parseClawHubSearchResults(
        """{"results":[{"slug":"pdf","installRef":"skills-sh:openai/skills/pdf","installOnly":true,"trustState":"not-scanned-by-clawhub","displayName":"Pdf"},{"slug":"pdf","installRef":"@awspace/pdf","displayName":"Pdf"}]}""",
        json,
      )

    val external = results.first()
    val native = results.last()
    // Rewriting the external reference to @openai/pdf would install a different skill.
    assertEquals("skills-sh:openai/skills/pdf", external.reference)
    assertFalse(external.canReadDetails)
    assertTrue(external.isUnscannedSource)
    assertTrue(native.canReadDetails)

    // Android installs this exact reference directly; it never creates a release review.
    assertEquals("skills-sh:openai/skills/pdf", external.reference)
  }

  @Test
  fun resultsWithoutTheInstallOnlyFlagKeepTheReviewFlow() {
    // A Gateway released before the flag existed omits it from every row.
    val results =
      parseClawHubSearchResults(
        """{"results":[{"slug":"email","installRef":"@alice/email","displayName":"Email"}]}""",
        json,
      )

    // Treating omission as install-only would bypass the reviewed-version step those Gateways
    // still expect.
    assertTrue(results.first().canReadDetails)
    assertFalse(results.first().isUnscannedSource)
  }

  @Test
  fun installOnlyReadbackMatchesTheRecordedReference() {
    val installed =
      listOf(
        GatewaySkillSummary(
          skillKey = "pdf",
          name = "pdf",
          description = null,
          source = "clawhub",
          emoji = null,
          disabled = false,
          eligible = true,
          blockedByAllowlist = false,
          blockedByAgentFilter = false,
          bundled = false,
          missingCount = 0,
          installCount = 0,
          clawHubSlug = "pdf",
          clawHubValid = true,
          clawHubRequestedReference = "skills-sh:openai/skills/pdf",
        ),
      )

    // The canonical slug is "pdf", so matching by the sent reference is the only readback that
    // identifies this install without colliding with a registry skill of the same slug.
    assertTrue(isClawHubSkillInstalledByReference(installed, "skills-sh:openai/skills/pdf"))
    assertTrue(
      isClawHubSkillInstalled(
        installed,
        GatewayClawHubSkillSummary(
          slug = "pdf",
          installRef = "skills-sh:openai/skills/pdf",
          installOnly = true,
          trustState = "not-scanned-by-clawhub",
          displayName = "Pdf",
          summary = null,
          version = null,
        ),
      ),
    )
    assertFalse(isClawHubSkillInstalledByReference(installed, "skills-sh:other/skills/pdf"))
  }

  @Test
  fun detailBindsExactVersionAndPublisherIdentity() {
    val review =
      parseClawHubInstallReview(
        """{"skill":{"displayName":"Alpha Skill","summary":"Reviewed metadata"},"latestVersion":{"version":"2.0.0"},"owner":{"displayName":"Alice","handle":"alice"}}""",
        GatewayClawHubSkillSummary("alpha", null, null, null, "Alpha", null, null),
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
        GatewayClawHubSkillSummary("alpha", null, null, null, "Alpha", null, "1.9.0"),
        json,
      )

    assertEquals("2.0.0", review?.version)
  }

  @Test
  fun detailFailsClosedWithoutAnInstallableVersion() {
    val review =
      parseClawHubInstallReview(
        """{"skill":{"displayName":"Alpha"},"owner":{"handle":"alice"}}""",
        GatewayClawHubSkillSummary("alpha", null, null, null, "Alpha", null, null),
        json,
      )

    assertNull(review)
  }

  @Test
  fun installParamsKeepRegistryAndTrustPolicyOnGateway() {
    for ((reference, version) in listOf("@alice/alpha" to " 1.2.3 ", "skills-sh:openai/skills/pdf" to null)) {
      val params = json.parseToJsonElement(clawHubInstallParams(reference, version)).jsonObject
      val expectedKeys = setOf("source", "slug", "timeoutMs") + if (version == null) emptySet() else setOf("version")

      assertEquals(expectedKeys, params.keys)
      assertEquals("clawhub", params.getValue("source").jsonPrimitive.content)
      assertEquals(reference, params.getValue("slug").jsonPrimitive.content)
      assertEquals(version?.trim(), params["version"]?.jsonPrimitive?.content)
      assertEquals(120_000, params.getValue("timeoutMs").jsonPrimitive.int)
    }
  }

  @Test
  fun rejectionKeepsGatewayMessageAndWarning() {
    for (message in listOf("review required", "download blocked", "security verification unavailable")) {
      val rejection =
        clawHubInstallRejection(
          GatewaySession.ErrorShape(
            code = "UNAVAILABLE",
            message = message,
            details =
              GatewayErrorDetails(
                code = null,
                canRetryWithDeviceToken = false,
                recommendedNextStep = null,
                clawhubWarning = "  ClawHub audit details.\n ",
              ),
          ),
        )

      assertEquals(message, rejection.message)
      assertEquals("ClawHub audit details.", rejection.warning)
      assertEquals("$message\n\nClawHub audit details.", formatClawHubInstallMessage(rejection.message, rejection.warning))
    }
  }

  @Test
  fun rejectionFallsBackForBlankMessagesAndOmitsEmptyWarnings() {
    for (warning in listOf(null, "", " \n ")) {
      val rejection =
        clawHubInstallRejection(
          GatewaySession.ErrorShape(
            code = "UNAVAILABLE",
            message = " \n ",
            details =
              warning?.let {
                GatewayErrorDetails(
                  code = null,
                  canRetryWithDeviceToken = false,
                  recommendedNextStep = null,
                  clawhubWarning = it,
                )
              },
          ),
        )

      assertEquals("The Gateway rejected this ClawHub install.", rejection.message)
      assertNull(rejection.warning)
      assertEquals(rejection.message, formatClawHubInstallMessage(rejection.message, rejection.warning))
    }
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
