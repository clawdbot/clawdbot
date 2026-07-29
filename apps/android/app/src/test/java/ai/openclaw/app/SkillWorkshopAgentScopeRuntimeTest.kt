package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.i18n.NativeText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SkillWorkshopAgentScopeRuntimeTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @Test
  fun gatewayActionsCarryClosedLocalizedPresentation() {
    val cases =
      listOf(
        SkillWorkshopGatewayAction.Apply to Triple("apply", "applied", "Proposal applied."),
        SkillWorkshopGatewayAction.Reject to Triple("reject", "rejected", "Proposal rejected."),
        SkillWorkshopGatewayAction.Quarantine to Triple("quarantine", "quarantined", "Proposal quarantined."),
      )

    for ((action, expected) in cases) {
      val (methodSuffix, expectedStatus, noticeSource) = expected
      assertEquals(methodSuffix, action.methodSuffix)
      assertEquals(expectedStatus, action.expectedStatus)
      assertEquals(NativeText.Resource(noticeSource, emptyList()), action.notice)
      assertEquals(NativeText.Resource(methodSuffix, emptyList()), action.verb)
      assertEquals(
        NativeText.Resource(
          source = "Gateway returned status '\$statusLabel' after \${action.verb}.",
          formatArgs = listOf(NativeText.Verbatim("future_status"), action.verb),
        ),
        skillWorkshopUnexpectedStatusText("future_status", action),
      )
      assertEquals(
        NativeText.Resource(
          source = "Could not \${action.verb} Skill Workshop proposal.",
          formatArgs = listOf(action.verb),
        ),
        skillWorkshopActionFailureText(action),
      )
    }
  }

  @Test
  fun missingGatewayActionStatusUsesLocalizedUnknownFallback() {
    assertEquals(
      NativeText.Resource(
        source = "Gateway returned status '\$statusLabel' after \${action.verb}.",
        formatArgs =
          listOf(
            NativeText.Resource(source = "unknown", formatArgs = emptyList()),
            SkillWorkshopGatewayAction.Apply.verb,
          ),
      ),
      skillWorkshopUnexpectedStatusText(null, SkillWorkshopGatewayAction.Apply),
    )
  }

  @Test
  fun resetSkillWorkshopAgentScopeClearsRowsAndInFlightActionState() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.resetSkillWorkshopAgentScope("main")
    readField<MutableStateFlow<GatewaySkillWorkshopSummary>>(runtime, "_skillWorkshopSummary").value =
      GatewaySkillWorkshopSummary(
        agentId = "main",
        proposals = listOf(skillWorkshopProposal("main-proposal")),
      )

    runtime.resetSkillWorkshopAgentScope("ops")

    assertEquals("ops", runtime.skillWorkshopSummary.value.agentId)
    assertEquals(emptyList<GatewaySkillWorkshopProposal>(), runtime.skillWorkshopSummary.value.proposals)
    assertFalse(runtime.skillWorkshopRefreshing.value)
    assertNull(runtime.skillWorkshopErrorText.value)
    assertNull(runtime.skillWorkshopNoticeText.value)
    assertNull(runtime.skillWorkshopInspectingProposalId.value)
    assertNull(runtime.skillWorkshopMutatingProposalId.value)
  }

  @Test
  fun inspectAndMutateDoNotStartForStaleSelectedAgentScope() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.resetSkillWorkshopAgentScope("main")

    runtime.inspectSkillWorkshopProposal(proposalId = "ops-proposal", agentId = "ops")
    readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.admin")
    waitUntil { runtime.operatorAdminScopeAvailable.value }
    runtime.applySkillWorkshopProposal(proposalId = "ops-proposal", agentId = "ops")
    Thread.sleep(100)

    assertEquals("main", runtime.skillWorkshopSummary.value.agentId)
    assertNull(runtime.skillWorkshopInspectingProposalId.value)
    assertNull(runtime.skillWorkshopMutatingProposalId.value)
    assertNull(runtime.skillWorkshopErrorText.value)
    assertNull(runtime.skillWorkshopNoticeText.value)
  }

  @Test
  fun busyProposalActionDoesNotInvalidateActiveRequestGenerations() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    readField<MutableStateFlow<GatewaySkillWorkshopSummary>>(runtime, "_skillWorkshopSummary").value =
      GatewaySkillWorkshopSummary(
        agentId = "main",
        proposals = listOf(skillWorkshopProposal("proposal-1")),
      )
    readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.admin")
    waitUntil { runtime.operatorAdminScopeAvailable.value }
    readField<MutableStateFlow<String?>>(runtime, "_skillWorkshopMutatingProposalId").value = "proposal-1"
    val mutationSeq = readField<AtomicLong>(runtime, "skillWorkshopMutationSeq").apply { set(41) }
    val inspectSeq = readField<AtomicLong>(runtime, "skillWorkshopInspectSeq").apply { set(17) }

    runtime.applySkillWorkshopProposal(proposalId = "proposal-1", agentId = "main")
    runtime.inspectSkillWorkshopProposal(proposalId = "proposal-1", agentId = "main")
    Thread.sleep(100)

    assertEquals(41, mutationSeq.get())
    assertEquals(17, inspectSeq.get())
    assertEquals("proposal-1", runtime.skillWorkshopMutatingProposalId.value)
    assertNull(runtime.skillWorkshopInspectingProposalId.value)
  }

  @Test
  fun proposalActionResultUsesGatewayReturnedStatusAndPreservesInspectedDetails() {
    val runtime = createTestRuntime()
    val supportFiles =
      listOf(GatewaySkillWorkshopSupportFile(path = "references/proof.md", content = "proof"))
    val previous =
      skillWorkshopProposal("proposal-1")
        .copy(
          status = "pending",
          content = "inspected markdown",
          supportFiles = supportFiles,
        )

    val rejected =
      parseSkillWorkshopActionResult(
        runtime,
        """
        {
          "record": {
            "id": "proposal-1",
            "kind": "create",
            "status": "rejected",
            "title": "Rejected proposal",
            "description": "Gateway action response",
            "createdAt": "2026-07-08T00:00:00Z",
            "updatedAt": "2026-07-09T00:00:00Z",
            "scan": { "state": "clean" },
            "target": { "skillName": "Rejected Skill", "skillKey": "rejected-skill" }
          }
        }
        """.trimIndent(),
        previous,
      )

    assertEquals("rejected", rejected?.status)
    assertEquals("2026-07-09T00:00:00Z", rejected?.updatedAt)
    assertEquals("Rejected Skill", rejected?.skillName)
    assertEquals("clean", rejected?.scanState)
    assertEquals("inspected markdown", rejected?.content)
    assertEquals(supportFiles, rejected?.supportFiles)
  }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
  }

  private fun skillWorkshopProposal(id: String): GatewaySkillWorkshopProposal =
    GatewaySkillWorkshopProposal(
      id = id,
      status = "pending",
      kind = "create",
      title = "Proposal $id",
      skillKey = id,
      skillName = "Proposal $id",
      description = "desc",
      createdAt = "2026-07-08T00:00:00Z",
      updatedAt = "2026-07-08T00:00:00Z",
      scanState = null,
    )

  private fun parseSkillWorkshopActionResult(
    runtime: NodeRuntime,
    payloadJson: String,
    previous: GatewaySkillWorkshopProposal,
  ): GatewaySkillWorkshopProposal? {
    val method =
      runtime.javaClass.getDeclaredMethod(
        "parseSkillWorkshopProposalActionResult",
        JsonObject::class.java,
        GatewaySkillWorkshopProposal::class.java,
      )
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    return method.invoke(
      runtime,
      json.parseToJsonElement(payloadJson).jsonObject,
      previous,
    ) as GatewaySkillWorkshopProposal?
  }

  private fun waitUntil(condition: () -> Boolean) {
    repeat(50) {
      if (condition()) return
      Thread.sleep(10)
    }
    error("Expected condition to become true")
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }

  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
