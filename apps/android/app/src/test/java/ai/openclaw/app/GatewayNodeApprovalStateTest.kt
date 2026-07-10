package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayConnectErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayNodeApprovalStateTest {
  @Test
  fun parsesGatewayNodeApprovalState() {
    assertEquals(GatewayNodeApprovalState.Approved, parseGatewayNodeApprovalState("approved"))
    assertEquals(GatewayNodeApprovalState.PendingApproval, parseGatewayNodeApprovalState("pending-approval"))
    assertEquals(GatewayNodeApprovalState.PendingReapproval, parseGatewayNodeApprovalState("pending-reapproval"))
    assertEquals(GatewayNodeApprovalState.Unapproved, parseGatewayNodeApprovalState("unapproved"))
    assertEquals(GatewayNodeApprovalState.Loading, parseGatewayNodeApprovalState(null))
    assertEquals(GatewayNodeApprovalState.Loading, parseGatewayNodeApprovalState("future-state"))
  }

  @Test
  fun nodePairingFailuresRefreshNodeDeviceState() {
    assertTrue(
      nodeConnectFailureNeedsApprovalRefresh(
        GatewaySession.ErrorShape(
          code = "NOT_PAIRED",
          message = "pairing required",
          details =
            GatewayConnectErrorDetails(
              code = "PAIRING_REQUIRED",
              canRetryWithDeviceToken = false,
              recommendedNextStep = "wait_then_retry",
              pauseReconnect = false,
              reason = "not-paired",
            ),
        ),
      ),
    )
    assertFalse(
      nodeConnectFailureNeedsApprovalRefresh(
        GatewaySession.ErrorShape(
          code = "UNAUTHORIZED",
          message = "token mismatch",
          details =
            GatewayConnectErrorDetails(
              code = "AUTH_TOKEN_MISMATCH",
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
            ),
        ),
      ),
    )
  }

  @Test
  fun parsesNodeListApprovalFields() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement(
          """
          {
            "nodeId": "android-node",
            "paired": true,
            "connected": true,
            "approvalState": "pending-approval",
            "pendingRequestId": "request-1",
            "caps": ["device"],
            "commands": ["device.status"]
          }
          """.trimIndent(),
        ),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeApprovalState.PendingApproval, node.approvalState)
    assertEquals("request-1", node.pendingRequestId)
    assertEquals(listOf("device"), node.capabilities)
    assertEquals(listOf("device.status"), node.commands)
  }

  @Test
  fun parsesSplitNodeListShapeFromGateway() {
    val root =
      Json
        .parseToJsonElement(
          """
          {
            "pending": [
              {
                "nodeId": "pending-node",
                "paired": false,
                "connected": false,
                "approvalState": "pending-approval",
                "pendingRequestId": "request-pending"
              }
            ],
            "paired": [
              {
                "nodeId": "self",
                "paired": true,
                "connected": true,
                "approvalState": "approved",
                "caps": ["device"],
                "commands": ["device.status"]
              }
            ]
          }
          """.trimIndent(),
        ).jsonObject

    val nodes = parseGatewayNodeList(root)

    assertEquals(2, nodes.size)
    assertEquals(
      GatewayNodeCapabilityApproval.Approved,
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "self"),
    )
  }

  @Test
  fun treatsMissingNodeApprovalStateAsUnsupported() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement("""{"nodeId":"android-node","paired":true,"connected":true}"""),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeApprovalState.Unsupported, node.approvalState)
    assertEquals(
      GatewayNodeCapabilityApproval.Unsupported,
      currentNodeCapabilityApproval(nodes = listOf(node), selfNodeId = "android-node"),
    )
    assertNull(node.pendingRequestId)
  }

  @Test
  fun resolvesCurrentPhoneNodeApprovalState() {
    val nodes =
      listOf(
        GatewayNodeSummary(
          id = "other",
          displayName = null,
          remoteIp = null,
          version = null,
          deviceFamily = null,
          paired = true,
          connected = false,
          approvalState = GatewayNodeApprovalState.Approved,
          pendingRequestId = null,
          capabilities = emptyList(),
          commands = emptyList(),
        ),
        GatewayNodeSummary(
          id = "self",
          displayName = null,
          remoteIp = null,
          version = null,
          deviceFamily = null,
          paired = true,
          connected = true,
          approvalState = GatewayNodeApprovalState.PendingApproval,
          pendingRequestId = "request-self",
          capabilities = emptyList(),
          commands = emptyList(),
        ),
      )

    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval("request-self"),
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeCapabilityApproval.Loading,
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "missing"),
    )
  }

  @Test
  fun ignoresStaleNodeApprovalRefreshResults() {
    val guard = LatestGatewayRefreshGuard()
    var approvalState = GatewayNodeApprovalState.Loading
    val staleRefresh = guard.begin()
    val currentRefresh = guard.begin()

    assertFalse(guard.publishIfCurrent(staleRefresh) { approvalState = GatewayNodeApprovalState.Approved })
    assertTrue(
      guard.publishIfCurrent(currentRefresh) { approvalState = GatewayNodeApprovalState.PendingReapproval },
    )
    assertEquals(GatewayNodeApprovalState.PendingReapproval, approvalState)
  }
}
