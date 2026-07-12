package ai.openclaw.app

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayExecApprovalParsingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun legacyListIsOpaqueDiscoveryOnly() {
    val rows =
      parseGatewayExecApprovalListPayload(
        """
        [
          {
            "id": "approval-2",
            "createdAtMs": 20,
            "expiresAtMs": 120,
            "request": {
              "host": "node",
              "nodeId": "node-1",
              "agentId": "agent-1",
              "command": "pnpm publish --token secret",
              "commandPreview": "secret preview"
            }
          },
          {
            "id": "approval-1",
            "createdAtMs": 10,
            "expiresAtMs": 110
          }
        ]
        """.trimIndent(),
        json,
      )

    assertEquals(listOf("approval-1", "approval-2"), rows.map { it.id })
    assertEquals(listOf("Command request", "Command request"), rows.map { it.commandText })
    assertTrue(rows.all { it.commandPreview == null })
    assertTrue(rows.all { it.allowedDecisions.isEmpty() })
    assertTrue(rows.all { it.host == null && it.nodeId == null && it.agentId == null })
  }

  @Test
  fun parsesPendingUnifiedExecApproval() {
    val snapshot =
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload(),
        json,
        expectedId = "approval-1",
      )

    val pending = snapshot as GatewayExecApprovalSnapshot.Pending
    assertEquals("approval-1", pending.id)
    assertEquals("rm -rf build", pending.summary.commandText)
    assertEquals("rm build", pending.summary.commandPreview)
    assertEquals("This command can delete files.", pending.summary.warningText)
    assertEquals(listOf("allow-once", "allow-always", "deny"), pending.summary.allowedDecisions)
    assertEquals("gateway", pending.summary.host)
    assertNull(pending.summary.nodeId)
    assertEquals("agent-main", pending.summary.agentId)
    assertEquals(100L, pending.summary.createdAtMs)
    assertEquals(200L, pending.summary.expiresAtMs)
  }

  @Test
  fun unifiedGetReturnsCanonicalTerminalSnapshot() {
    val snapshot =
      parseGatewayExecApprovalGetPayload(
        terminalPayload(status = "expired", reason = "timeout"),
        json,
        expectedId = "approval-1",
      )

    val terminal = snapshot as GatewayExecApprovalSnapshot.Terminal
    assertEquals(GatewayApprovalTerminalStatus.Expired, terminal.status)
    assertNull(terminal.decision)
  }

  @Test
  fun resolveAcceptsAnotherSurfacesCanonicalWinner() {
    val resolution =
      parseGatewayExecApprovalResolvePayload(
        """
        {
          "applied": false,
          "approval": ${terminalApproval(status = "denied", reason = "user", decision = "deny")}
        }
        """.trimIndent(),
        json,
        expectedId = "approval-1",
        expectedDecision = "allow-once",
      )

    requireNotNull(resolution)
    assertFalse(resolution.applied)
    assertEquals(GatewayApprovalTerminalStatus.Denied, resolution.approval.status)
    assertEquals("deny", resolution.approval.decision)
  }

  @Test
  fun resolveAcceptsAppliedAllowWinner() {
    val resolution =
      parseGatewayExecApprovalResolvePayload(
        """
        {
          "applied": true,
          "approval": ${terminalApproval(status = "allowed", reason = "user", decision = "allow-once")}
        }
        """.trimIndent(),
        json,
        expectedId = "approval-1",
        expectedDecision = "allow-once",
      )

    requireNotNull(resolution)
    assertTrue(resolution.applied)
    assertEquals(GatewayApprovalTerminalStatus.Allowed, resolution.approval.status)
    assertEquals("allow-once", resolution.approval.decision)
  }

  @Test
  fun unifiedParsingRejectsWrongOwnerIdentityAndMalformedVerdicts() {
    assertNull(
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload().replace("\"kind\": \"exec\"", "\"kind\": \"plugin\""),
        json,
        expectedId = "approval-1",
      ),
    )
    assertNull(
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload(),
        json,
        expectedId = "approval-other",
      ),
    )
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":"false","approval":${terminalApproval(status = "denied", reason = "user", decision = "deny")}}""",
        json,
        expectedId = "approval-1",
        expectedDecision = "deny",
      ),
    )
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":false,"approval":${terminalApproval(status = "allowed", reason = "user", decision = "deny")}}""",
        json,
        expectedId = "approval-1",
        expectedDecision = "deny",
      ),
    )
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":false,"approval":${pendingApproval()}}""",
        json,
        expectedId = "approval-1",
        expectedDecision = "deny",
      ),
    )
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":false,"approval":${terminalApproval(status = "denied", reason = "user", decision = "deny")}}""",
        json,
        expectedId = "approval-other",
        expectedDecision = "deny",
      ),
    )
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":true,"approval":${terminalApproval(status = "denied", reason = "user", decision = "deny")}}""",
        json,
        expectedId = "approval-1",
        expectedDecision = "allow-once",
      ),
    )
  }

  @Test
  fun acceptsOnlyExactClosedExecDecisions() {
    assertEquals("allow-once", normalizeGatewayExecApprovalDecision("allow-once"))
    assertEquals("allow-always", normalizeGatewayExecApprovalDecision("allow-always"))
    assertEquals("deny", normalizeGatewayExecApprovalDecision("deny"))
    assertNull(normalizeGatewayExecApprovalDecision(" allow-once "))
    assertNull(normalizeGatewayExecApprovalDecision("ALLOW-ONCE"))
    assertNull(normalizeGatewayExecApprovalDecision("deny\n"))
    assertNull(normalizeGatewayExecApprovalDecision("deny\u0000"))
    assertNull(normalizeGatewayExecApprovalDecision("accept"))
    assertNull(normalizeGatewayExecApprovalDecision(""))
  }

  @Test
  fun unifiedParsingRejectsUnknownFieldsAtEverySchemaBoundary() {
    assertNull(
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload().replaceFirst("{", "{\"unexpected\":true,"),
        json,
        expectedId = "approval-1",
      ),
    )
    assertNull(
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload()
          .replaceFirst(
            "\"status\": \"pending\"",
            "\"status\": \"pending\", \"resolvedBy\": \"phone\"",
          ),
        json,
        expectedId = "approval-1",
      ),
    )
    assertNull(
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload()
          .replaceFirst(
            "\"kind\": \"exec\"",
            "\"kind\": \"exec\", \"cwd\": \"/tmp\"",
          ),
        json,
        expectedId = "approval-1",
      ),
    )
    assertNull(
      parseGatewayExecApprovalGetPayload(
        terminalPayload(status = "denied", reason = "user", decision = "deny")
          .replaceFirst(
            "\"reason\": \"user\"",
            "\"reason\": \"user\", \"resolvedBy\": \"phone\"",
          ),
        json,
        expectedId = "approval-1",
      ),
    )
    val terminal = terminalApproval(status = "denied", reason = "user", decision = "deny")
    assertNull(
      parseGatewayExecApprovalResolvePayload(
        """{"applied":false,"unexpected":true,"approval":$terminal}""",
        json,
        expectedId = "approval-1",
        expectedDecision = "deny",
      ),
    )
  }

  @Test
  fun unifiedParsingRequiresPathStableWellFormedApprovalIds() {
    val malformedIds =
      listOf(
        "\"\"" to "",
        "\".\"" to ".",
        "\"..\"" to "..",
        "\"\\ud800\"" to "\uD800",
        "\"\\udc00\"" to "\uDC00",
      )
    for ((encodedId, expectedId) in malformedIds) {
      assertNull(
        parseGatewayExecApprovalGetPayload(
          pendingGetPayload().replaceFirst("\"approval-1\"", encodedId),
          json,
          expectedId = expectedId,
        ),
      )
    }

    val astralId = "approval:🦞/percent%"
    val snapshot =
      parseGatewayExecApprovalGetPayload(
        pendingGetPayload().replaceFirst("approval-1", astralId),
        json,
        expectedId = astralId,
      )
    assertEquals(astralId, snapshot?.id)
  }

  @Test
  fun unifiedAllowedTerminalDecisionMustHaveBeenOffered() {
    val payload =
      terminalPayload(status = "allowed", reason = "user", decision = "allow-once")
        .replace(
          "[\"allow-once\", \"allow-always\", \"deny\"]",
          "[\"allow-always\", \"deny\"]",
        )

    assertNull(parseGatewayExecApprovalGetPayload(payload, json, expectedId = "approval-1"))
  }

  @Test
  fun buildsUnifiedRuntimeRequestsWithExplicitOwner() {
    assertEquals("""{"id":"approval-1"}""", buildGatewayExecApprovalGetParams("approval-1").toString())
    assertEquals(
      """{"id":"approval-1","kind":"exec","decision":"deny"}""",
      buildGatewayExecApprovalResolveParams(id = "approval-1", decision = "deny").toString(),
    )
  }

  @Test
  fun legacyGatewayCompatibilityStillValidatesIdentityAndAck() {
    val pending =
      parseLegacyGatewayExecApprovalGetPayload(
        """
        {
          "id": "approval-1",
          "commandText": "echo ok",
          "commandPreview": "echo",
          "allowedDecisions": ["allow-once", "deny"],
          "host": "gateway",
          "nodeId": null,
          "agentId": "main",
          "expiresAtMs": 200
        }
        """.trimIndent(),
        json,
        expectedId = "approval-1",
        createdAtMs = 100,
      )

    requireNotNull(pending)
    assertEquals(listOf("allow-once", "deny"), pending.summary.allowedDecisions)
    assertNull(
      parseLegacyGatewayExecApprovalGetPayload(
        """{"id":"other","commandText":"echo","allowedDecisions":["deny"]}""",
        json,
        expectedId = "approval-1",
        createdAtMs = 100,
      ),
    )
    assertNull(
      parseLegacyGatewayExecApprovalGetPayload(
        """{"id":"approval-1","commandText":"echo","expiresAtMs":200}""",
        json,
        expectedId = "approval-1",
        createdAtMs = 100,
      ),
    )
    assertNull(
      parseLegacyGatewayExecApprovalGetPayload(
        """{"id":"approval-1","commandText":"echo","allowedDecisions":["deny"]}""",
        json,
        expectedId = "approval-1",
        createdAtMs = 100,
      ),
    )
    assertNull(
      parseLegacyGatewayExecApprovalGetPayload(
        """{"id":"approval-1","commandText":"echo","allowedDecisions":["deny"],"expiresAtMs":-1}""",
        json,
        expectedId = "approval-1",
        createdAtMs = 100,
      ),
    )
    assertNull(
      parseLegacyGatewayExecApprovalGetPayload(
        """{"id":"approval-1","commandText":"echo","allowedDecisions":["deny"],"expiresAtMs":200}""",
        json,
        expectedId = "approval-1",
        createdAtMs = -1,
      ),
    )
    assertTrue(parseLegacyGatewayExecApprovalResolvePayload("""{"ok":true}""", json))
    assertFalse(parseLegacyGatewayExecApprovalResolvePayload("""{"ok":"true"}""", json))
    assertFalse(parseLegacyGatewayExecApprovalResolvePayload("""{"ok":false}""", json))
  }

  @Test
  fun approvalRpcFamilyPinsOnlyCompleteHelloCatalogs() {
    assertEquals(
      GatewayApprovalRpcFamily.Canonical,
      selectGatewayApprovalRpcFamily(
        setOf(
          "approval.get",
          "approval.resolve",
          "exec.approval.get",
          "exec.approval.resolve",
        ),
      ),
    )
    assertEquals(
      GatewayApprovalRpcFamily.Legacy,
      selectGatewayApprovalRpcFamily(
        setOf("exec.approval.get", "exec.approval.resolve"),
      ),
    )
    val unavailableCatalogs: List<Set<String>> =
      listOf(
        emptySet(),
        setOf("approval.get"),
        setOf("approval.resolve"),
        setOf("exec.approval.get"),
        setOf("exec.approval.resolve"),
        setOf("approval.get", "exec.approval.get", "exec.approval.resolve"),
        setOf("approval.resolve", "exec.approval.get", "exec.approval.resolve"),
      )
    for (methods in unavailableCatalogs) {
      assertEquals(
        GatewayApprovalRpcFamily.Unavailable,
        selectGatewayApprovalRpcFamily(methods),
      )
    }
  }

  @Test
  fun localAndRemoteTerminalNoticesPreserveCanonicalOutcome() {
    // Field comparison: every constructed notice carries a distinct publication token,
    // so whole-value equality would never hold across separately built notices.
    assertNoticeContent(
      gatewayExecApprovalRemoteTerminalNotice(
        terminal(status = GatewayApprovalTerminalStatus.Denied, decision = "deny"),
      ),
      message = "A prior response already denied this approval.",
      warning = true,
    )
    assertNoticeContent(
      gatewayExecApprovalRemoteTerminalNotice(terminal(status = GatewayApprovalTerminalStatus.Expired)),
      message = "This approval expired before it could be resolved.",
      warning = true,
    )
    assertNoticeContent(
      gatewayExecApprovalRemoteTerminalNotice(terminal(status = GatewayApprovalTerminalStatus.Cancelled)),
      message = "This approval was cancelled before it could be resolved.",
      warning = true,
    )
    assertNoticeContent(
      gatewayExecApprovalResolutionNotice(
        resolution(
          applied = false,
          status = GatewayApprovalTerminalStatus.Allowed,
          decision = "allow-always",
        ),
      ),
      message = "A prior response already allowed this command and saved the choice.",
      warning = false,
    )
    assertNoticeContent(
      gatewayExecApprovalResolutionNotice(
        resolution(
          applied = false,
          status = GatewayApprovalTerminalStatus.Allowed,
          decision = "allow-always",
          attribution = GatewayExecApprovalResolutionAttribution.Unknown,
        ),
      ),
      message = "Gateway recorded approval and saved the choice.",
      warning = false,
    )
    assertNoticeContent(
      gatewayExecApprovalResolutionNotice(
        resolution(
          applied = false,
          status = GatewayApprovalTerminalStatus.Denied,
          decision = "deny",
          attribution = GatewayExecApprovalResolutionAttribution.Unknown,
        ),
      ),
      message = "Gateway recorded a denial.",
      warning = true,
    )
  }

  private fun assertNoticeContent(
    notice: GatewayExecApprovalNotice,
    approvalId: String = "approval-1",
    message: String,
    warning: Boolean,
  ) {
    assertEquals(approvalId, notice.approvalId)
    assertEquals(message, notice.message)
    assertEquals(warning, notice.warning)
  }

  @Test
  fun ignoresMalformedGatewayExecApprovalListPayload() {
    assertTrue(parseGatewayExecApprovalListPayload("""{"approvals":[]}""", json).isEmpty())
    assertTrue(parseGatewayExecApprovalListPayload("not json", json).isEmpty())
    assertTrue(
      parseGatewayExecApprovalListPayload(
        """[{"id":"approval-1","createdAtMs":-1,"expiresAtMs":100}]""",
        json,
      ).isEmpty(),
    )
    assertTrue(
      parseGatewayExecApprovalListPayload(
        """[{"id":"approval-1","createdAtMs":1}]""",
        json,
      ).isEmpty(),
    )
  }

  private fun pendingGetPayload(): String = """{"approval":${pendingApproval()}}"""

  private fun resolution(
    applied: Boolean,
    status: GatewayApprovalTerminalStatus,
    decision: String? = null,
    attribution: GatewayExecApprovalResolutionAttribution =
      if (applied) GatewayExecApprovalResolutionAttribution.AppliedHere else GatewayExecApprovalResolutionAttribution.PriorResponse,
  ): GatewayExecApprovalResolution =
    GatewayExecApprovalResolution(
      applied = applied,
      approval = terminal(status = status, decision = decision),
      attribution = attribution,
    )

  private fun terminal(
    status: GatewayApprovalTerminalStatus,
    decision: String? = null,
  ): GatewayExecApprovalSnapshot.Terminal =
    GatewayExecApprovalSnapshot.Terminal(
      id = "approval-1",
      status = status,
      decision = decision,
    )

  private fun pendingApproval(): String =
    """
    {
      "id": "approval-1",
      "urlPath": "/approve/approval-1",
      "status": "pending",
      "createdAtMs": 100,
      "expiresAtMs": 200,
      "presentation": ${execPresentation()}
    }
    """.trimIndent()

  private fun terminalPayload(
    status: String,
    reason: String,
    decision: String? = null,
  ): String = """{"approval":${terminalApproval(status, reason, decision)}}"""

  private fun terminalApproval(
    status: String,
    reason: String,
    decision: String? = null,
  ): String {
    val decisionField = decision?.let { ", \"decision\": \"$it\"" }.orEmpty()
    return """
      {
        "id": "approval-1",
        "urlPath": "/approve/approval-1",
        "status": "$status",
        "createdAtMs": 100,
        "expiresAtMs": 200,
        "presentation": ${execPresentation()},
        "resolvedAtMs": 150,
        "reason": "$reason"$decisionField
      }
      """.trimIndent()
  }

  private fun execPresentation(): String =
    """
    {
      "kind": "exec",
      "commandText": "rm -rf build",
      "commandPreview": "rm build",
      "warningText": "This command can delete files.",
      "host": "gateway",
      "nodeId": null,
      "agentId": "agent-main",
      "allowedDecisions": ["allow-once", "allow-always", "deny"]
    }
    """.trimIndent()
}
