package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayProtocolGeneratedTest {
  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
      explicitNulls = false
    }

  @Test
  fun requestFrameEncodingIncludesTheDiscriminatorAndOmitsNullParams() {
    val encoded =
      json
        .encodeToJsonElement(
          GatewayRequestFrame.serializer(),
          GatewayRequestFrame(id = "request-1", method = GatewayMethod.Health.rawValue),
        ).jsonObject

    assertEquals("req", encoded.getValue("type").jsonPrimitive.content)
    assertEquals("request-1", encoded.getValue("id").jsonPrimitive.content)
    assertEquals(GatewayMethod.Health.rawValue, encoded.getValue("method").jsonPrimitive.content)
    assertNull(encoded["params"])
  }

  @Test
  fun nodeInvokeRequestUsesTheSchemaWireNames() {
    val decoded =
      json.decodeFromString(
        GatewayNodeInvokeRequest.serializer(),
        """{"id":"invoke-1","nodeId":"node-1","command":"device.info","paramsJSON":"{}","timeoutMs":5000}""",
      )

    assertEquals("invoke-1", decoded.id)
    assertEquals("node-1", decoded.nodeId)
    assertEquals("device.info", decoded.command)
    assertEquals("{}", decoded.paramsJson)
    assertEquals(5_000L, decoded.timeoutMs)
  }

  @Test
  fun projectsListResultDecodesALegacyProjectsOnlyPayload() {
    val decoded = json.decodeFromString(ProjectsListResult.serializer(), """{"projects":[]}""")

    assertTrue(decoded.projects.isEmpty())
    assertNull(decoded.observedProjects)
  }

  @Test
  fun legacyFramesDecodePrincipalLessSharingErrorsAndRefreshEvents() {
    for (id in listOf("unknown", "absent")) {
      val response =
        json.decodeFromString(
          GatewayResponseFrame.serializer(),
          """{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"session membership includes actor evidence this client cannot represent","details":{"code":"SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED","recommendedMethod":"session.members.listEvidence"}}}""",
        )
      assertEquals("INVALID_REQUEST", response.error?.code)
      assertEquals(
        "session.members.listEvidence",
        response.error
          ?.details
          ?.jsonObject
          ?.get("recommendedMethod")
          ?.jsonPrimitive
          ?.content,
      )
    }

    val ignoredEvidence =
      json.decodeFromString(
        GatewayEventFrame.serializer(),
        """{"type":"event","event":"session.sharing.evidence","payload":{"action":"member-added","sessionKey":"agent:main:main","agentId":"main","actorState":"unknown","identityId":"profile-bob","ts":2}}""",
      )
    val refresh =
      json.decodeFromString(
        GatewayEventFrame.serializer(),
        """{"type":"event","event":"sessions.changed","payload":{"reason":"sharing","sessionKey":"agent:main:main","agentId":"main","ts":2}}""",
      )
    assertEquals("session.sharing.evidence", ignoredEvidence.event)
    assertEquals("sessions.changed", refresh.event)
    assertEquals(
      "sharing",
      refresh.payload
        ?.jsonObject
        ?.get("reason")
        ?.jsonPrimitive
        ?.content,
    )
  }

  @Test
  fun generatedGatewayCatalogsAreCompleteAndUnique() {
    val methods = GatewayMethod.entries.map { it.rawValue }
    val events = GatewayEvent.entries.map { it.rawValue }

    assertTrue(methods.size > 200)
    assertTrue(events.size > 20)
    assertEquals(methods.size, methods.toSet().size)
    assertEquals(events.size, events.toSet().size)
    assertEquals("sessions.move", GatewayMethod.SessionsMove.rawValue)
  }

  @Test
  fun githubPublicationResultsRoundTripAsATypedUnion() {
    val cases =
      listOf(
        """{"requestId":"request-1","status":"requested","message":"Accepted."}""" to
          SessionGitHubPublicationRequested::class,
        """{"requestId":"request-1","status":"publishing","message":"Publishing."}""" to
          SessionGitHubPublicationPublishing::class,
        """{"requestId":"request-1","status":"published","url":"https://github.com/openclaw/openclaw/pull/1","repository":"openclaw/openclaw","branch":"openclaw/task","headCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}""" to
          SessionGitHubPublicationPublished::class,
        """{"requestId":"request-1","status":"failed","code":"push_rejected","message":"Failed.","nextAction":"Check access."}""" to
          SessionGitHubPublicationFailed::class,
        """{"requestId":"request-1","status":"needs_confirmation","publisher":{"source":"personal","accountId":42,"login":"octocat"},"message":"Confirm publication."}""" to
          SessionGitHubPublicationNeedsConfirmation::class,
      )

    for ((payload, expectedType) in cases) {
      val decoded = json.decodeFromString(SessionGitHubPublicationResult.serializer(), payload)
      assertEquals(expectedType, decoded::class)
      assertEquals(
        json.parseToJsonElement(payload),
        json.encodeToJsonElement(SessionGitHubPublicationResult.serializer(), decoded),
      )
    }
  }

  @Test
  fun githubDeviceAuthorizationResultsDecodeAsATypedUnion() {
    val cases =
      listOf(
        """{"status":"pending","retryAfterMs":5000}""" to
          ToolsGitHubAuthorizePendingResult::class,
        """{"status":"slow_down","retryAfterMs":10000}""" to
          ToolsGitHubAuthorizeSlowDownResult::class,
        """{"status":"access_denied"}""" to ToolsGitHubAuthorizeAccessDeniedResult::class,
        """{"status":"expired"}""" to ToolsGitHubAuthorizeExpiredResult::class,
        """{"status":"incorrect_device_code"}""" to
          ToolsGitHubAuthorizeIncorrectDeviceCodeResult::class,
        """{"status":"network_error","retryAfterMs":5000}""" to
          ToolsGitHubAuthorizeNetworkErrorResult::class,
        """{"status":"failed","reason":"identity_changed"}""" to
          ToolsGitHubAuthorizeFailedResult::class,
        """{"status":"success","githubStatus":{"agentId":"main","selectedScope":"system","selected":{"scope":"system","configured":true,"identity":{"source":"system-configured","credentialKind":"managed-oauth","credentialState":"available","account":{"login":"octocat"},"gitAuthor":{"name":"octocat","email":"1+octocat@users.noreply.github.com"},"evidence":"github-api","accessExpiresAtMs":1800000000000,"refreshState":"available","oauthScopes":["repo"],"repositoryGrants":"unknown"}},"effective":{"source":"system-configured","credentialKind":"managed-oauth","credentialState":"available","account":{"login":"octocat"},"gitAuthor":{"name":"octocat","email":"1+octocat@users.noreply.github.com"},"evidence":"github-api","accessExpiresAtMs":1800000000000,"refreshState":"available","oauthScopes":["repo"],"repositoryGrants":"unknown"}}}""" to
          ToolsGitHubAuthorizeSuccessResult::class,
      )

    for ((payload, expectedType) in cases) {
      val decoded = json.decodeFromString(ToolsGitHubAuthorizePollResult.serializer(), payload)
      assertEquals(expectedType, decoded::class)
    }
  }
}
