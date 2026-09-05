package ai.openclaw.app

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.chat.ChatComposerStateStore
import ai.openclaw.app.ui.chat.PendingAttachment
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainViewModelTest {
  @After
  fun resetNodeServiceStartSuppression() {
    val app = RuntimeEnvironment.getApplication()
    NodeForegroundService.resume(app, startNow = false)
    (app as NodeApp).chatShareDraftQueue.clear()
    val appShadow = shadowOf(app)
    while (appShadow.nextStartedService != null) {
      // Drain queued service intents so each test owns its lifecycle assertions.
    }
  }

  @Test
  fun foregroundStartupRequiresForegroundAndCompletedOnboarding() {
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = true,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = false,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = false,
      ),
    )
    assertTrue(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = true,
      ),
    )
  }

  @Test
  fun cronEditorDraftMemoryIsBoundedAndClearsOnlyItsOwningJob() {
    val memory = CronEditorDraftMemory()
    val first = draft("First")
    val second = draft("Second")

    memory.set("job-a", first)
    assertEquals(first, memory.get("job-a"))
    assertNull(memory.get("job-b"))

    memory.set("job-b", second)
    assertNull(memory.get("job-a"))
    memory.clear("job-a")
    assertEquals(second, memory.get("job-b"))

    memory.set("job-b", null)
    assertNull(memory.get("job-b"))
  }

  @Test
  fun disconnectStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)
    prefs.setOnboardingCompleted(true)

    viewModel.disconnect()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)

    viewModel.resumeNodeServiceForConnection()

    assertNodeServiceResumeRequested()
  }

  @Test
  fun pairNewGatewayStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)

    viewModel.pairNewGateway()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)
  }

  @Test
  fun assistantLaunchDraftCapturesItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()

    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "captured prompt",
        autoSend = false,
      ),
    )

    val draft = requireNotNull(viewModel.chatDraft.value)
    val captured = requireNotNull(draft.owner)
    assertEquals("captured prompt", draft.text)
    assertNull(
      claimChatDraftForOwner(
        draft = draft,
        owner = captured.copy(gatewayStableId = "another-gateway", agentId = "another-agent"),
        mainSessionKey = "agent:another-agent:main",
      ),
    )
  }

  @Test
  fun assistantAutoSendCapturesAndMigratesItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()

    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "send to the captured chat",
        autoSend = true,
      ),
    )

    val pending = requireNotNull(viewModel.pendingAssistantAutoSend.value)
    val resolvedOwner =
      pending.owner.copy(
        agentId = "work",
        sessionKey = "agent:work:device",
        routingVerified = true,
      )
    viewModel.resolveChatComposerOwnerAliases(to = resolvedOwner, mainSessionKey = resolvedOwner.sessionKey)

    assertEquals("send to the captured chat", viewModel.pendingAssistantAutoSend.value?.prompt)
    assertEquals(resolvedOwner, viewModel.pendingAssistantAutoSend.value?.owner)
  }

  @Test
  fun mediaAuthorizationMigratesWithItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()
    val provisional = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val resolved = ChatComposerOwner("gateway", "work", "agent:work:device")
    val authorizationId = requireNotNull(viewModel.chatComposerState.beginMediaAcquisition(provisional))

    viewModel.resolveChatComposerOwnerAliases(to = resolved, mainSessionKey = resolved.sessionKey)

    assertEquals(
      0,
      viewModel.chatComposerState.addAuthorizedAttachments(
        owner = resolved,
        mediaAuthorizationId = authorizationId,
        candidates = listOf(PendingAttachment("migrated", "photo.jpg", "image/jpeg", "YQ==")),
      ),
    )
    assertEquals(
      1,
      viewModel.chatComposerState.attachments.value[resolved]
        ?.size,
    )
  }

  @Test
  fun completedAssistantAutoSendClearsItsMigratedOperationButNotAReplacement() {
    val original =
      PendingAssistantAutoSend(
        prompt = "send once",
        owner = ChatComposerOwner("gateway", "main", "main"),
      )
    val migrated = original.copy(owner = original.owner.copy(sessionKey = "agent:main:device"))
    val replacement = PendingAssistantAutoSend(prompt = original.prompt, owner = migrated.owner)

    assertNull(clearCompletedAssistantAutoSend(migrated, original.id))
    assertEquals(replacement, clearCompletedAssistantAutoSend(replacement, original.id))
  }

  @Test
  fun refusedAssistantPromptBecomesEditableWithoutOverwritingNewerText() {
    assertEquals("send once", retainRefusedAssistantPrompt("send once", ""))
    assertEquals("send once\n\nnewer edit", retainRefusedAssistantPrompt("send once", "newer edit"))
    assertEquals("send once", retainRefusedAssistantPrompt("send once", "send once"))
  }

  @Test
  fun assistantAutoSendSharesTheManualComposerAdmissionGate() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val state = ChatComposerStateStore()

    val sendId = requireNotNull(state.tryBeginTrackedSend(owner))
    assertNull(state.tryBeginTrackedSend(owner))
    state.finishTrackedSend(sendId)
    assertNotNull(state.tryBeginTrackedSend(owner))
  }

  @Test
  fun warmShareIntentsQueueOnceInArrivalOrderWithCapturedOwner() {
    val (viewModel, _) = createViewModel(resolveShareMimeType = { "application/pdf" })
    val firstUri = Uri.parse("content://share/first")
    val secondUri = Uri.parse("content://share/second")
    val owner = viewModel.captureChatShareOwner()

    assertTrue(viewModel.handleShareLaunchIntent(shareIntent(firstUri, "first")))
    assertTrue(viewModel.handleShareLaunchIntent(shareIntent(secondUri, "second")))

    assertTrue(waitUntil { viewModel.chatShareDrafts.value.size == 2 })
    val drafts = viewModel.chatShareDrafts.value
    assertEquals(listOf("first", "second"), drafts.map(ChatShareDraft::text))
    assertEquals(listOf(firstUri, secondUri), drafts.map { draft -> draft.attachments.single().uri })
    assertTrue(drafts.all { draft -> viewModel.chatShareDraftTargetsOwner(draft.id, owner, owner.sessionKey) })
  }

  @Test
  fun blockedShareReportsRetainedOverflowAndReleasesItsSlot() {
    val resolverEntered = CountDownLatch(1)
    val releaseResolver = CountDownLatch(1)
    val blockedUri = Uri.parse("content://share/blocked")
    val nextUri = Uri.parse("content://share/next")
    val (viewModel, _) =
      createViewModel(
        resolveShareMimeType = { uri ->
          if (uri == blockedUri) {
            resolverEntered.countDown()
            check(releaseResolver.await(5, TimeUnit.SECONDS))
          }
          "application/pdf"
        },
        shareLaunchCapacity = 1,
      )

    assertTrue(viewModel.handleShareLaunchIntent(shareIntent(blockedUri, "blocked")))
    assertTrue(resolverEntered.await(5, TimeUnit.SECONDS))
    assertFalse(viewModel.handleShareLaunchIntent(shareIntent(nextUri, "overflow")))
    assertEquals(1L, viewModel.shareLaunchOverflowRevision.value)

    releaseResolver.countDown()
    assertTrue(waitUntil { viewModel.chatShareDrafts.value.size == 1 })
    assertEquals(1, viewModel.takeShareLaunchOverflowCount())
    assertEquals(0, viewModel.takeShareLaunchOverflowCount())
    viewModel.reportShareLaunchOverflow(2)
    viewModel.reportShareLaunchOverflow()
    assertEquals(3L, viewModel.shareLaunchOverflowRevision.value)
    assertEquals(3, viewModel.takeShareLaunchOverflowCount())

    (RuntimeEnvironment.getApplication() as NodeApp).chatShareDraftQueue.clear()
    assertTrue(viewModel.handleShareLaunchIntent(shareIntent(nextUri, "next")))
    assertTrue(
      waitUntil {
        viewModel.chatShareDrafts.value
          .singleOrNull()
          ?.text == "next"
      },
    )
  }

  @Test
  fun gatewayAuthResetCleanupPurgesOnlyThatGatewaysComposerState() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val removed =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "main")
      val retained =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-b", "main", "main")
      viewModel.chatComposerState.textDrafts[removed] = "private a"
      viewModel.chatComposerState.textDrafts[retained] = "private b"
      val removedAttachment = PendingAttachment("a", "a.txt", "text/plain", "YQ==")
      val retainedAttachment = PendingAttachment("b", "b.txt", "text/plain", "Yg==")
      viewModel.chatComposerState.addAttachments(removed, listOf(removedAttachment))
      viewModel.chatComposerState.addAttachments(retained, listOf(retainedAttachment))

      viewModel.clearChatComposerGateway("gateway-a")

      assertEquals("", viewModel.chatComposerState.textDrafts[removed])
      assertEquals("private b", viewModel.chatComposerState.textDrafts[retained])
      assertEquals(null, viewModel.chatComposerState.attachments.value[removed])
      assertEquals(listOf(retainedAttachment), viewModel.chatComposerState.attachments.value[retained])
    }

  @Test
  fun gatewayAuthResetRejectsMediaCompletionsCapturedByRetiredCredentials() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val owner = ChatComposerOwner("gateway-a", "main", "main")
      val authorizationId = requireNotNull(viewModel.chatComposerState.beginMediaAcquisition(owner))
      var imageLoaderCalled = false

      viewModel.clearChatComposerGateway("gateway-a")

      assertFalse(viewModel.chatComposerState.isMediaAcquisitionActive(authorizationId))
      assertNull(
        viewModel.chatComposerState.addAuthorizedAttachments(
          owner = owner,
          mediaAuthorizationId = authorizationId,
          candidates = listOf(PendingAttachment("late", "late.txt", "text/plain", "YQ==")),
        ),
      )
      viewModel.importChatComposerAttachments(owner, authorizationId, mainSessionKey = "main", expectedCount = 1) {
        imageLoaderCalled = true
        listOf(PendingAttachment("late-image", "late.jpg", "image/jpeg", "YQ=="))
      }
      assertFalse(imageLoaderCalled)
      assertNull(viewModel.chatComposerState.attachments.value[owner])
    }

  @Test
  fun deletedSessionCleanupPurgesItsMainAliasesWithoutTouchingSiblingOwners() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val alias =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "main")
      val canonical =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "agent:main:device")
      val provisional =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "placeholder", "main", routingVerified = false)
      val sibling =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "agent:main:other")
      val otherAgent =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "work", "agent:main:device")
      val mediaAuthorizationId = requireNotNull(viewModel.chatComposerState.beginMediaAcquisition(canonical))
      listOf(alias, canonical, provisional, sibling, otherAgent).forEach { owner ->
        viewModel.chatComposerState.textDrafts[owner] = owner.toString()
        viewModel.chatComposerState.addAttachments(
          owner,
          listOf(PendingAttachment(owner.toString(), "draft.txt", "text/plain", "YQ==")),
        )
      }

      viewModel.clearChatComposerSession(
        gatewayStableId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        mainSessionKey = "agent:main:device",
      )

      assertEquals("", viewModel.chatComposerState.textDrafts[alias])
      assertEquals("", viewModel.chatComposerState.textDrafts[canonical])
      assertEquals("", viewModel.chatComposerState.textDrafts[provisional])
      assertEquals(sibling.toString(), viewModel.chatComposerState.textDrafts[sibling])
      assertEquals(otherAgent.toString(), viewModel.chatComposerState.textDrafts[otherAgent])
      assertEquals(null, viewModel.chatComposerState.attachments.value[alias])
      assertEquals(null, viewModel.chatComposerState.attachments.value[canonical])
      assertEquals(null, viewModel.chatComposerState.attachments.value[provisional])
      assertEquals(
        1,
        viewModel.chatComposerState.attachments.value[sibling]
          ?.size,
      )
      assertEquals(
        1,
        viewModel.chatComposerState.attachments.value[otherAgent]
          ?.size,
      )
      assertFalse(viewModel.chatComposerState.isMediaAcquisitionActive(mediaAuthorizationId))
      assertNull(
        viewModel.chatComposerState.addAuthorizedAttachments(
          owner = canonical,
          mediaAuthorizationId = mediaAuthorizationId,
          candidates = listOf(PendingAttachment("late", "late.txt", "text/plain", "YQ==")),
        ),
      )
    }

  @Test
  fun replyDraftRejectsACallbackCapturedForAnotherChat() {
    val (viewModel, _) = createViewModel()
    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "initial",
        autoSend = false,
      ),
    )
    val owner = requireNotNull(viewModel.chatDraft.value?.owner)

    viewModel.setChatReplyDraft("quoted", owner)
    assertEquals("quoted", viewModel.chatDraft.value?.text)

    viewModel.setChatReplyDraft("stale", owner.copy(sessionKey = "agent:main:another"))
    assertEquals("quoted", viewModel.chatDraft.value?.text)
  }

  private fun assertNodeServiceStopRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStoppedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertNull(shadowOf(app).nextStartedService)
  }

  private fun assertNodeServiceResumeRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStartedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertEquals("ai.openclaw.app.action.RESUME", intent?.action)
  }

  private fun createViewModel(
    resolveShareMimeType: (Uri) -> String? = { null },
    shareLaunchCapacity: Int = MAX_PENDING_CHAT_SHARES,
  ): Pair<MainViewModel, SecurePrefs> {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        securePrefsOverride =
          app.getSharedPreferences(
            "main-view-model-test-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
          ),
      )
    return (
      MainViewModel(
        app = app,
        prefs = prefs,
        savedStateHandle = SavedStateHandle(),
        resolveShareMimeType = resolveShareMimeType,
        shareLaunchCapacity = shareLaunchCapacity,
      ) to
        prefs
    )
  }

  private fun shareIntent(
    uri: Uri,
    text: String,
  ): Intent =
    Intent(Intent.ACTION_SEND)
      .setType("*/*")
      .putExtra(Intent.EXTRA_TEXT, text)
      .putExtra(Intent.EXTRA_STREAM, uri)

  private fun waitUntil(
    timeoutMillis: Long = 2_000,
    predicate: () -> Boolean,
  ): Boolean {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
    while (System.nanoTime() < deadline) {
      shadowOf(Looper.getMainLooper()).idle()
      if (predicate()) return true
      Thread.sleep(10)
    }
    shadowOf(Looper.getMainLooper()).idle()
    return predicate()
  }

  private fun draft(name: String): CronEditorDraftState {
    val edit =
      GatewayCronJobEdit(
        name = name,
        description = "",
        enabled = true,
        deleteAfterRun = false,
        schedule = GatewayCronScheduleEdit.At("2026-07-10T09:00:00Z"),
        sessionTarget = "isolated",
        wakeMode = "now",
        payload = GatewayCronPayloadEdit.SystemEvent("Wake up"),
      )
    return CronEditorDraftState(
      baseline = edit,
      edit = edit.copy(name = "$name draft"),
    )
  }
}
