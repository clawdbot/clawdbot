package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.ChatShareDraft
import ai.openclaw.app.SharedAttachment
import ai.openclaw.app.SharedAttachmentKind
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.GatewayDefaultAgentOwner
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.chat.resolveChatComposerRoutingOwner
import ai.openclaw.app.claimChatDraftForOwner
import android.net.Uri
import androidx.compose.runtime.saveable.SaverScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatComposerDraftTest {
  @Test
  fun dictationAppendsToTheCurrentDraftWithoutEatingSpacing() {
    assertEquals("hello world", appendChatDictationTranscript("hello", " world "))
    assertEquals("hello world", appendChatDictationTranscript("hello ", " world "))
    assertEquals("hello", appendChatDictationTranscript("hello", "   "))
  }

  @Test
  fun dictationFillsAnEmptyDraft() {
    assertEquals("hello world", appendChatDictationTranscript("", " hello world "))
  }

  @Test
  fun textDraftsRemainKeyedToTheirComposerOwner() {
    val store = ChatComposerTextDraftStore()
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val second = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:second")

    store[first] = "first draft"
    store[second] = "second draft"

    assertEquals("first draft", store[first])
    assertEquals("second draft", store[second])
  }

  @Test
  fun sendPayloadReadsCurrentOwnerStoresAfterEditsAndRemovals() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val state = ChatComposerStateStore()
    val removed = PendingAttachment("removed", "removed.jpg", "image/jpeg", "YQ==")
    val retained = PendingAttachment("retained", "retained.jpg", "image/jpeg", "Yg==")
    state.textDrafts[owner] = "old text"
    state.addAttachments(owner, listOf(removed))

    state.textDrafts[owner] = "  edited text  "
    state.removeAttachments(owner, setOf(removed.id))
    state.addAttachments(owner, listOf(retained))

    val request = requireNotNull(state.beginSend(owner).request)

    assertEquals("  edited text  ", request.inputSnapshot)
    assertEquals("edited text", request.message)
    assertEquals(listOf(retained), request.attachments)
  }

  @Test
  fun textDraftSnapshotRestoresEveryOwnerAfterProcessRecreation() {
    var saved = arrayListOf<String>()
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val second = ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "work", sessionKey = "agent:work:second")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[first] = "first draft"
    store[second] = "second draft"

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("first draft", restored[first])
    assertEquals("second draft", restored[second])
  }

  @Test
  fun processRecreationHidesPendingDraftUntilOutboxReconciliation() {
    var saved = arrayListOf<String>()
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("", restored[owner])
    assertEquals(listOf("command-a"), restored.pendingAdmissions().map { it.commandId })
    restored.resolveAdmission("command-a", admitted = false)
    assertEquals("send once", restored[owner])
  }

  @Test
  fun oversizedPendingDraftIsNotHiddenWithoutACompleteCrashCheckpoint() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val oversized = "x".repeat(CHAT_COMPOSER_MAX_SEND_CHARS + 1)
    val store = ChatComposerTextDraftStore()
    store[owner] = oversized

    assertFalse(store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = oversized))

    assertEquals(oversized, store[owner])
    assertTrue(store.pendingAdmissions().isEmpty())
  }

  @Test
  fun pendingDraftBudgetIncludesOtherOwnersAdmissions() {
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val second = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:second")
    val third = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:third")
    val fourth = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:fourth")
    val store = ChatComposerTextDraftStore()
    store[first] = "a".repeat(CHAT_COMPOSER_MAX_SEND_CHARS)
    store[second] = "b".repeat(CHAT_COMPOSER_MAX_SEND_CHARS)
    store[third] = "c".repeat(CHAT_COMPOSER_MAX_SEND_CHARS)
    store[fourth] = "d".repeat(10_000)

    assertTrue(store.beginAdmission(commandId = "command-a", owner = first, inputSnapshot = store[first]))
    assertTrue(store.beginAdmission(commandId = "command-b", owner = second, inputSnapshot = store[second]))
    assertTrue(store.beginAdmission(commandId = "command-c", owner = third, inputSnapshot = store[third]))
    assertFalse(store.beginAdmission(commandId = "command-d", owner = fourth, inputSnapshot = store[fourth]))

    assertEquals("", store[first])
    assertEquals("", store[second])
    assertEquals("", store[third])
    assertEquals("d".repeat(10_000), store[fourth])
    assertEquals(
      listOf("command-a", "command-b", "command-c"),
      store.pendingAdmissions().map(PendingChatComposerSend::commandId),
    )
  }

  @Test
  fun restoredPendingAdmissionMigratesWithoutAVisibleDraft() {
    var saved = arrayListOf<String>()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[alias] = "send once"
    store.beginAdmission(commandId = "command-a", owner = alias, inputSnapshot = "send once")
    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("", restored[alias])
    assertEquals(setOf(alias), restored.migrateMatching(canonical, canonical.sessionKey))
    assertEquals(canonical, restored.pendingAdmissions().single().owner)

    restored.resolveAdmission("command-a", admitted = false)
    assertEquals("", restored[alias])
    assertEquals("send once", restored[canonical])
  }

  @Test
  fun acceptedAliasAdmissionKeepsTheCanonicalDraftMergedBeforeResolution() {
    var saved = arrayListOf<String>()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[alias] = "already sent"
    store[canonical] = "keep editing"
    store.beginAdmission(commandId = "command-a", owner = alias, inputSnapshot = "already sent")
    store.migrate(alias, canonical)

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))
    assertEquals("keep editing", restored[canonical])
    restored.resolveAdmission("command-a", admitted = true)

    assertEquals("keep editing", restored[canonical])
  }

  @Test
  fun rejectedAliasAdmissionRestoresSentTextAfterTheCanonicalDraft() {
    var saved = arrayListOf<String>()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[alias] = "retry me"
    store[canonical] = "keep editing"
    store.beginAdmission(commandId = "command-a", owner = alias, inputSnapshot = "retry me")
    store.migrate(alias, canonical)

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))
    restored.resolveAdmission("command-a", admitted = false)

    assertEquals("retry me\n\nkeep editing", restored[canonical])
  }

  @Test
  fun removingGatewayDraftsAlsoRemovesItsPendingAdmission() {
    val removed = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val retained = ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "main", sessionKey = "main")
    val store = ChatComposerTextDraftStore()
    store[removed] = "private a"
    store[retained] = "private b"
    store.beginAdmission(commandId = "command-a", owner = removed, inputSnapshot = "private a")

    store.removeOwners { it.gatewayStableId == "gateway-a" }

    assertEquals("", store[removed])
    assertEquals("private b", store[retained])
    assertTrue(store.pendingAdmissions().isEmpty())
  }

  @Test
  fun durablePendingSendStaysHiddenAndLaterEditsSurviveReconciliation() {
    var saved = arrayListOf<String>()
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")
    assertEquals("", store[owner])
    store[owner] = "new draft"

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))
    assertEquals("new draft", restored[owner])

    restored.resolveAdmission("command-a", admitted = true)
    assertEquals("new draft", restored[owner])
    assertTrue(restored.pendingAdmissions().isEmpty())
  }

  @Test
  fun identicallyRetypedDraftSurvivesAcceptedAdmission() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore()
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")
    store[owner] = "send once"

    store.resolveAdmission("command-a", admitted = true)

    assertEquals("send once", store[owner])
  }

  @Test
  fun rejectedPendingSendRestoresOriginalBeforePostAdmissionEdits() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val store = ChatComposerTextDraftStore()
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")
    store[owner] = "new draft"

    store.resolveAdmission("command-a", admitted = false)

    assertEquals("send once\n\nnew draft", store[owner])
  }

  @Test
  fun pendingReplyDraftClaimsTheCanonicalMainAliasOwner() {
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val draft = ChatDraft(text = "reply", placement = ChatDraftPlacement.BeforeExisting, owner = alias)

    val claimed = claimChatDraftForOwner(draft, canonical, canonical.sessionKey)

    assertEquals(canonical, claimed?.owner)
    assertEquals("reply", claimed?.text)
  }

  @Test
  fun textDraftStoreEvictsTheOldestOwnerAndBoundsProcessCheckpoint() {
    var saved = arrayListOf<String>()
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    val owners =
      (0..CHAT_COMPOSER_MAX_DRAFT_OWNERS).map { index ->
        ChatComposerOwner(
          gatewayStableId = "gateway-a",
          agentId = "main",
          sessionKey = "agent:main:$index",
        )
      }

    val longDraft = "x".repeat(40_000)
    owners.forEach { owner -> store[owner] = longDraft }

    assertEquals(CHAT_COMPOSER_MAX_DRAFT_OWNERS, store.size())
    assertEquals("", store[owners.first()])
    assertEquals(longDraft, store[owners.last()])
    assertTrue(saved.sumOf(String::length) <= CHAT_COMPOSER_DRAFT_SNAPSHOT_MAX_CHARS)
    assertEquals(longDraft, ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))[owners.last()])
  }

  @Test
  fun mainAliasDraftMovesToCanonicalMainOwner() {
    val store = ChatComposerTextDraftStore()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    store[alias] = "typed while connecting"

    assertTrue(shouldMigrateComposerDraft(alias, canonical, canonical.sessionKey))
    store.migrate(from = alias, to = canonical)

    assertEquals("", store[alias])
    assertEquals("typed while connecting", store[canonical])
  }

  @Test
  fun mainAliasDraftDoesNotCrossGatewayOrAgent() {
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")

    assertFalse(
      shouldMigrateComposerDraft(
        alias,
        ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "main", sessionKey = "agent:main:device"),
        "agent:main:device",
      ),
    )
    assertFalse(
      shouldMigrateComposerDraft(
        alias,
        ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "other", sessionKey = "agent:other:device"),
        "agent:other:device",
      ),
    )
  }

  @Test
  fun mainAliasMigrationPreservesAnExistingCanonicalDraft() {
    val store = ChatComposerTextDraftStore()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    store[alias] = "typed while connecting"
    store[canonical] = "saved canonical draft"

    store.migrate(from = alias, to = canonical)

    assertEquals("saved canonical draft\n\ntyped while connecting", store[canonical])
  }

  @Test
  fun aliasResolutionPreservesEveryActiveSendAndPendingAcknowledgement() {
    val alias = ChatComposerOwner("gateway-a", "main", "main")
    val provisional = ChatComposerOwner("gateway-a", "main", "main", routingVerified = false)
    val canonical = ChatComposerOwner("gateway-a", "main", "agent:main:device")
    val state = ChatComposerStateStore()
    state.textDrafts[alias] = "manual send"
    val manualRequest = requireNotNull(state.beginSend(alias).request)
    state.completeSend(manualRequest, accepted = true)
    val trackedSendId = requireNotNull(state.tryBeginTrackedSend(provisional))
    state.textDrafts[canonical] = "second manual send"
    val activeManualRequest = requireNotNull(state.beginSend(canonical).request)

    state.resolveAliases(canonical, canonical.sessionKey)

    assertEquals(
      ChatComposerSendState(
        activeOperationIds = setOf(trackedSendId, activeManualRequest.commandId),
        pendingAdmissionIds = setOf(manualRequest.commandId),
      ),
      state.sendStates.value[canonical],
    )
    state.acknowledgeSendAdmission(canonical, manualRequest.commandId)
    assertEquals(
      ChatComposerSendState(activeOperationIds = setOf(trackedSendId, activeManualRequest.commandId)),
      state.sendStates.value[canonical],
    )
    assertNull(state.tryBeginTrackedSend(canonical))

    state.finishTrackedSend(trackedSendId)
    assertEquals(
      ChatComposerSendState(activeOperationIds = setOf(activeManualRequest.commandId)),
      state.sendStates.value[canonical],
    )
    state.completeSend(activeManualRequest, accepted = true)
    assertEquals(
      ChatComposerSendState(pendingAdmissionIds = setOf(activeManualRequest.commandId)),
      state.sendStates.value[canonical],
    )
    state.acknowledgeSendAdmission(canonical, activeManualRequest.commandId)
    assertNotNull(state.tryBeginTrackedSend(canonical))
  }

  @Test
  fun gatewayBoundProvisionalDraftMovesToItsVerifiedOwner() {
    val store = ChatComposerTextDraftStore()
    val provisional =
      ChatComposerOwner(
        gatewayStableId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        routingVerified = false,
      )
    val verified = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "work", sessionKey = "agent:work:device")
    store[provisional] = "typed before gateway hello"

    assertTrue(shouldMigrateComposerDraft(provisional, verified, verified.sessionKey))
    store.migrate(provisional, verified)

    assertEquals("", store[provisional])
    assertEquals("typed before gateway hello", store[verified])
  }

  @Test
  fun provisionalOwnerCheckpointSurvivesRecreation() {
    val provisional =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "main",
        sessionKey = "main",
        routingVerified = false,
      )

    val restored = chatComposerOwnerFromCheckpointValues(provisional.toCheckpointValues())

    assertEquals(provisional, restored)
  }

  @Test
  fun ownerlessProvisionalDraftMovesWhenAGatewayIsSelected() {
    val unresolvedGateway =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "main",
        sessionKey = "custom",
      )
    val resolvedGateway = unresolvedGateway.copy(gatewayStableId = "gateway-a", routingVerified = true)

    assertTrue(shouldMigrateComposerDraft(unresolvedGateway, resolvedGateway, "agent:main:device"))
  }

  @Test
  fun ownerlessProvisionalDraftWaitsForVerifiedGatewayRouting() {
    val unresolvedGateway =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "main",
        sessionKey = "custom",
      )
    val selectedGateway = unresolvedGateway.copy(gatewayStableId = "gateway-a", agentId = "other")

    assertFalse(shouldMigrateComposerDraft(unresolvedGateway, selectedGateway, "agent:other:device"))
  }

  @Test
  fun verifiedOwnerlessDraftDoesNotCrossAgentsWhenAGatewayIsSelected() {
    val captured =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "agent-a",
        sessionKey = "custom",
        routingVerified = true,
      )
    val current = captured.copy(gatewayStableId = "gateway-a", agentId = "agent-b")

    assertFalse(shouldMigrateComposerDraft(captured, current, "agent:agent-b:device"))
  }

  @Test
  fun verifiedDraftDoesNotMoveWhenTheDefaultOwnerChanges() {
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "first", sessionKey = "custom")
    val second = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "second", sessionKey = "custom")

    assertFalse(shouldMigrateComposerDraft(first, second, "agent:second:device"))
  }

  @Test
  fun replyDraftPreservesExistingComposerText() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    assertEquals("> quoted\n\nmy reply", mergeChatDraft(draft, "my reply"))
  }

  @Test
  fun replacementDraftReplacesExistingComposerText() {
    val draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace)

    assertEquals("repeat this", mergeChatDraft(draft, "existing text"))
  }

  @Test
  fun guardedReplacementPreservesComposerEditsMadeWhileActionWasInFlight() {
    val draft =
      ChatDraft(
        text = "rewound text",
        placement = ChatDraftPlacement.Replace,
        expectedExistingText = "before",
      )

    assertEquals(null, mergeChatDraft(draft, "typed while waiting"))
    assertEquals("rewound text", mergeChatDraft(draft, "before"))
  }

  @Test
  fun rewindReplacementCanIntentionallyClearTheComposer() {
    val draft =
      ChatDraft(
        text = "",
        placement = ChatDraftPlacement.Replace,
        expectedExistingText = "before",
        acceptsEmptyText = true,
      )

    assertEquals("", mergeChatDraft(draft, "before"))
  }

  @Test
  fun replyDraftCanOnlyMergeIntoItsOriginatingOwner() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting, owner = owner)

    assertEquals(
      null,
      mergeChatDraft(draft = draft, currentInput = "wrong", currentOwner = owner.copy(sessionKey = "session-b")),
    )
    assertEquals(
      "> quoted\n\nreply",
      mergeChatDraft(draft = draft, currentInput = "reply", currentOwner = owner),
    )
  }

  @Test
  fun sharedTextPreservesExistingComposerText() {
    assertEquals(
      "existing draft\n\nshared link",
      mergeSharedChatText(sharedText = "shared link", currentInput = "existing draft"),
    )
  }

  @Test
  fun queuedSharedTextPreservesArrivalOrder() {
    val first = mergeSharedChatText(sharedText = "first", currentInput = "")

    assertEquals("first\n\nsecond", mergeSharedChatText(sharedText = "second", currentInput = first))
  }

  @Test
  fun imageOnlyShareLeavesExistingComposerTextUntouched() {
    assertEquals(
      "existing draft",
      mergeSharedChatText(sharedText = null, currentInput = "existing draft"),
    )
  }

  @Test
  fun stagedSharePreservesComposerAndReportsDroppedImages() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val existing = pendingAttachment("existing")
    val shared = pendingAttachment("shared")
    val staged =
      StagedChatShare(
        text = "shared link",
        attachments = listOf(shared),
        failedAttachmentCount = 0,
        droppedAttachmentCount = 2,
      )

    store.add(owner, listOf(existing))
    val omitted = store.add(owner, staged.attachments)

    assertEquals("existing draft\n\nshared link", mergeSharedChatText(staged.text, "existing draft"))
    assertEquals(listOf(existing, shared), store.get(owner))
    assertEquals(2, staged.failedAttachmentCount + staged.droppedAttachmentCount + omitted)
  }

  @Test
  fun unreadableSharedImageDoesNotDiscardOtherStagedContent() =
    runBlocking {
      val readable = Uri.parse("content://photos/readable")
      val unreadable = Uri.parse("content://photos/unreadable")
      val draft =
        ChatShareDraft(
          id = 1,
          text = "caption",
          attachments = listOf(sharedAttachment(readable), sharedAttachment(unreadable)),
          droppedAttachmentCount = 0,
        )

      val staged =
        stageChatShareDraft(draft) { attachment ->
          if (attachment.uri == unreadable) error("provider read failed")
          pendingAttachment(attachment.uri.toString())
        }

      assertEquals("caption", staged.text)
      assertEquals(listOf(readable.toString()), staged.attachments.map { it.id })
      assertEquals(1, staged.failedAttachmentCount)
      assertEquals(0, staged.droppedAttachmentCount)
    }

  @Test
  fun screenDisposalCancellationLeavesShareUnstaged() {
    val draft =
      ChatShareDraft(
        id = 1,
        text = null,
        attachments = listOf(sharedAttachment(Uri.parse("content://photos/slow"))),
        droppedAttachmentCount = 0,
      )

    assertThrows(CancellationException::class.java) {
      runBlocking {
        stageChatShareDraft(draft) { throw CancellationException("screen disposed") }
      }
    }
  }

  @Test
  fun repeatedSharesRespectExistingComposerAttachmentLimit() =
    runBlocking {
      val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
      val store = ChatComposerAttachmentStore()
      val current = (1..7).map { pendingAttachment("existing-$it") }
      val uris = (1..3).map { Uri.parse("content://photos/shared/$it") }
      val draft =
        ChatShareDraft(
          id = 1,
          text = null,
          attachments = uris.map(::sharedAttachment),
          droppedAttachmentCount = 0,
        )

      val staged =
        stageChatShareDraft(draft) { attachment ->
          pendingAttachment(attachment.uri.toString())
        }

      assertEquals(uris.map(Uri::toString), staged.attachments.map { it.id })
      assertEquals(0, staged.droppedAttachmentCount)
      store.add(owner, current)
      val omitted = store.add(owner, staged.attachments)
      assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.get(owner).size)
      assertEquals(2, staged.droppedAttachmentCount + omitted)
    }

  @Test
  fun mergeRechecksAttachmentBudgetAfterStaging() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val staged =
      StagedChatShare(
        text = null,
        attachments = listOf(pendingAttachment("one"), pendingAttachment("two")),
        failedAttachmentCount = 0,
        droppedAttachmentCount = 0,
      )
    val current = (1..7).map { pendingAttachment("existing-$it") }

    store.add(owner, current)
    val omitted = store.add(owner, staged.attachments)

    assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.get(owner).size)
    assertEquals(1, staged.droppedAttachmentCount + omitted)
  }

  @Test
  fun sharedAttachmentsAtomicallyMergeWithAConcurrentPickerImport() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val existing = pendingAttachment("existing")
    val picker = pendingAttachment("picker")
    val shared = pendingAttachment("shared")
    store.add(owner, listOf(existing))

    store.add(owner, listOf(picker))
    store.add(owner, listOf(shared))

    assertEquals(listOf(existing, picker, shared), store.get(owner))
  }

  @Test
  fun attachmentAdmissionEnforcesBase64AndDecodedBudgets() {
    val candidates = listOf(pendingAttachment("one", base64 = "AAAA"), pendingAttachment("two", base64 = "AAAA"))

    val base64Bound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 4,
        maxDecodedBytes = 100,
      )
    val decodedBound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 100,
        maxDecodedBytes = 3,
      )

    assertEquals(listOf(candidates.first()), base64Bound.accepted)
    assertEquals(1, base64Bound.omittedCount)
    assertEquals(listOf(candidates.first()), decodedBound.accepted)
    assertEquals(1, decodedBound.omittedCount)
  }

  @Test
  fun attachmentAdmissionUsesPerKindDecodedBudgets() {
    assertEquals(CHAT_COMPOSER_MAX_IMAGE_DECODED_BYTES, chatComposerAttachmentDecodedByteLimit("image/png"))
    assertEquals(CHAT_COMPOSER_MAX_AUDIO_DECODED_BYTES, chatComposerAttachmentDecodedByteLimit("audio/mpeg"))
    assertEquals(CHAT_COMPOSER_MAX_DOCUMENT_DECODED_BYTES, chatComposerAttachmentDecodedByteLimit("application/pdf"))
  }

  @Test
  fun stagedShareCommitsOnlyForMatchingQueueHead() {
    val current = ChatShareDraft(id = 7, text = "current", attachments = emptyList(), droppedAttachmentCount = 0)
    val replacement = ChatShareDraft(id = 8, text = "replacement", attachments = emptyList(), droppedAttachmentCount = 0)
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")

    assertTrue(canCommitStagedChatShare(current.id, current, owner, owner))
    assertFalse(canCommitStagedChatShare(current.id, replacement, owner, owner))
    assertFalse(canCommitStagedChatShare(current.id, null, owner, owner))
  }

  @Test
  fun pendingAttachmentsRemainKeyedAcrossComposerNavigationAndOwnerResolution() {
    val ownerA = ChatComposerOwner(gatewayStableId = "gateway", agentId = "agent-a", sessionKey = "session-a")
    val ownerB = ChatComposerOwner(gatewayStableId = "gateway", agentId = "agent-b", sessionKey = "session-b")
    val resolvedA = ownerA.copy(sessionKey = "agent:agent-a:device")
    val store = ChatComposerAttachmentStore()
    val first = pendingAttachment("first")
    val second = pendingAttachment("second")
    val late = pendingAttachment("late")
    val importId = store.beginImport(ownerA)

    store.add(ownerA, listOf(first))
    store.add(ownerB, listOf(second))
    assertEquals(listOf(first), store.attachments.value[ownerA])
    assertEquals(listOf(second), store.attachments.value[ownerB])

    store.migrate(ownerA, resolvedA)
    assertEquals(null, store.attachments.value[ownerA])
    assertEquals(listOf(first), store.attachments.value[resolvedA])
    assertEquals(listOf(second), store.attachments.value[ownerB])

    // Only the decode that was already in flight follows the explicit owner migration.
    store.completeImport(importId, listOf(late))
    assertEquals(listOf(first, late), store.attachments.value[resolvedA])

    val reusedProvisional = pendingAttachment("reused")
    store.add(ownerA, listOf(reusedProvisional))
    assertEquals(listOf(reusedProvisional), store.attachments.value[ownerA])

    store.remove(resolvedA, setOf(first.id, late.id))
    assertEquals(null, store.attachments.value[resolvedA])
  }

  @Test
  fun removingGatewayAttachmentsAlsoCancelsItsInFlightImports() {
    val removed = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val retained = ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "main", sessionKey = "main")
    val store = ChatComposerAttachmentStore()
    val removedAttachment = pendingAttachment("removed")
    val retainedAttachment = pendingAttachment("retained")
    val removedImport = store.beginImport(removed)
    store.add(removed, listOf(removedAttachment))
    store.add(retained, listOf(retainedAttachment))

    store.removeOwners { it.gatewayStableId == "gateway-a" }

    assertEquals(emptyList<PendingAttachment>(), store.get(removed))
    assertEquals(listOf(retainedAttachment), store.get(retained))
    assertEquals(null, store.completeImport(removedImport, listOf(pendingAttachment("late"))))
  }

  @Test
  fun ownerResolutionMigratesParkedDraftsAttachmentsAndImportsAfterNavigation() {
    val provisional = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val unrelated = ChatComposerOwner("gateway", "other", "agent:other:device")
    val resolved = ChatComposerOwner("gateway", "work", "agent:work:device")
    val drafts = ChatComposerTextDraftStore()
    val attachments = ChatComposerAttachmentStore()
    val parked = pendingAttachment("parked")
    val late = pendingAttachment("late")
    val unrelatedAttachment = pendingAttachment("unrelated")
    drafts[provisional] = "parked draft"
    drafts[unrelated] = "other draft"
    attachments.add(provisional, listOf(parked))
    attachments.add(unrelated, listOf(unrelatedAttachment))
    val importId = attachments.beginImport(provisional)

    assertEquals(setOf(provisional), drafts.migrateMatching(resolved, resolved.sessionKey))
    val migration = attachments.migrateMatching(resolved, resolved.sessionKey)
    attachments.completeImport(importId, listOf(late))

    assertEquals(setOf(provisional), migration.sources)
    assertEquals(0, migration.omittedCount)
    assertEquals("parked draft", drafts[resolved])
    assertEquals("other draft", drafts[unrelated])
    assertEquals(listOf(parked, late), attachments.get(resolved))
    assertEquals(listOf(unrelatedAttachment), attachments.get(unrelated))
  }

  @Test
  fun pendingAttachmentsAreBoundedAcrossComposerOwners() {
    val ownerA = ChatComposerOwner("gateway", "agent-a", "session-a")
    val ownerB = ChatComposerOwner("gateway", "agent-b", "session-b")
    val store =
      ChatComposerAttachmentStore(
        maxTotalAttachmentCount = 8,
        maxTotalBase64Chars = 8,
        maxTotalDecodedBytes = 5,
      )
    val first = pendingAttachment("first", base64 = "AAAA")
    val second = pendingAttachment("second", base64 = "BBBB")

    assertEquals(0, store.add(ownerA, listOf(first)))
    assertEquals(1, store.add(ownerB, listOf(second)))
    assertEquals(listOf(first), store.attachments.value[ownerA])
    assertEquals(null, store.attachments.value[ownerB])
  }

  @Test
  fun ownerMigrationDropsAndReportsAttachmentsBeyondTheDestinationLimit() {
    val from = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val to = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val destination = (1..7).map { pendingAttachment("destination-$it") }
    val source = listOf(pendingAttachment("source-1"), pendingAttachment("source-2"))
    store.add(to, destination)
    store.add(from, source)

    assertEquals(1, store.migrate(from, to))
    assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.attachments.value[to]?.size)
    assertEquals(null, store.attachments.value[from])
    store.remove(to, store.get(to).mapTo(mutableSetOf()) { it.id })
    assertEquals(0, store.migrate(from, to))
    assertEquals(null, store.attachments.value[to])
  }

  @Test
  fun voiceNoteCompletionMustMatchTheRecordingThatStartedIt() {
    val ownerA = ChatComposerOwner("gateway", "agent-a", "session-a")
    val ownerB = ChatComposerOwner("gateway", "agent-b", "session-b")
    val checkpoint = ChatComposerMediaCheckpoint()

    checkpoint.begin(ownerA, mediaAuthorizationId = "auth-a", requestId = "recording-a")
    checkpoint.begin(ownerB, mediaAuthorizationId = "auth-b", requestId = "recording-b")

    assertEquals(null, checkpoint.consume("recording-a"))
    assertEquals(ownerB, checkpoint.owner)
    assertEquals(ChatComposerMediaLease(ownerB, "auth-b"), checkpoint.consume("recording-b"))
    assertEquals(null, checkpoint.owner)
  }

  @Test
  fun imagePickerCheckpointCarriesTheCredentialGenerationThroughRecreation() {
    val owner = ChatComposerOwner("gateway", "agent", "session")
    val checkpoint = ChatComposerMediaCheckpoint()
    checkpoint.begin(owner, mediaAuthorizationId = "media-auth")
    val saverScope = SaverScope { true }
    val saved =
      with(ChatComposerMediaCheckpoint.Saver) {
        saverScope.save(checkpoint)
      }
    val restored = requireNotNull(ChatComposerMediaCheckpoint.Saver.restore(requireNotNull(saved)))

    assertEquals(ChatComposerMediaLease(owner, "media-auth"), restored.consume())
  }

  @Test
  fun voiceRecorderSurvivesOnlyCanonicalOwnerMigration() {
    val provisional = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val canonical = ChatComposerOwner("gateway", "work", "agent:work:device")
    val tracker = VoiceNoteRecorderOwnerTracker(provisional)

    assertTrue(tracker.moveTo(canonical, canonical.sessionKey))
    assertFalse(tracker.moveTo(canonical.copy(sessionKey = "agent:work:other"), canonical.sessionKey))
  }

  @Test
  fun composerOwnerUsesTheSameSessionFallbackAsTheViewModel() {
    assertEquals(
      ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "alpha", sessionKey = "agent:alpha:main"),
      resolveChatComposerOwner(
        gatewayStableId = "gateway-a",
        gatewayDefaultAgentId = "main",
        sessionKey = " ",
        mainSessionKey = "agent:alpha:main",
      ),
    )
  }

  @Test
  fun composerOwnerRetainsVerifiedRoutingOnlyForTheSameGateway() {
    val retained = GatewayDefaultAgentOwner(gatewayStableId = "gateway-a", agentId = "agent-a")

    assertEquals(
      ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "main"),
      resolveChatComposerOwner(
        gatewayStableId = "gateway-a",
        gatewayDefaultAgentId = null,
        lastVerifiedOwner = retained,
        sessionKey = "main",
        mainSessionKey = "main",
      ),
    )
    assertFalse(
      resolveChatComposerOwner(
        gatewayStableId = "gateway-b",
        gatewayDefaultAgentId = null,
        lastVerifiedOwner = retained,
        sessionKey = "main",
        mainSessionKey = "main",
      ).routingVerified,
    )
  }

  @Test
  fun routingOwnerRejectsABlankGatewayDefaultAgent() {
    assertEquals(
      null,
      resolveChatComposerRoutingOwner(
        gatewayStableId = "gateway-a",
        gatewayDefaultAgentId = "  ",
        sessionKey = "main",
        mainSessionKey = "main",
      ),
    )
  }

  @Test
  fun stagedShareRejectsAReplacementComposerOwner() {
    val share = ChatShareDraft(id = 7, text = "share", attachments = emptyList(), droppedAttachmentCount = 0)
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")

    assertFalse(
      canCommitStagedChatShare(
        stagedId = share.id,
        currentHead = share,
        ownerSnapshot = owner,
        currentOwner = owner.copy(sessionKey = "session-b"),
      ),
    )
  }

  @Test
  fun sendIsDisabledWhileShareHeadStages() {
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = true,
        sendInFlight = false,
      ),
    )
    assertTrue(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
        sendInFlight = false,
      ),
    )
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
        sendInFlight = true,
      ),
    )
  }

  @Test
  fun sendIsDisabledWhileDictationIsActive() {
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
        dictationActive = true,
      ),
    )
  }

  private fun pendingAttachment(
    id: String,
    base64: String = id,
  ): PendingAttachment =
    PendingAttachment(
      id = id,
      fileName = "$id.jpg",
      mimeType = "image/jpeg",
      base64 = base64,
    )

  private fun sharedAttachment(uri: Uri): SharedAttachment =
    SharedAttachment(
      uri = uri,
      kind = SharedAttachmentKind.Image,
      mimeType = "image/jpeg",
    )
}
