package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.ConnectionManager
import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.lang.reflect.InvocationTargetException
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn

private const val APPEARANCE_CONNECTION_TIMEOUT_MS = 8_000L

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppearancePreferenceRuntimeTest {
  @Test
  fun concurrentWritesForOneKeyFinishWithTheLatestValue() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val profile = profileScope("profile-a")
        val firstWriteStarted = CompletableDeferred<Unit>()
        val releaseFirstWrite = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.method == "users.prefs.set" && request.entry("ui.theme") == "claw") {
            firstWriteStarted.complete(Unit)
            releaseFirstWrite.await()
          }
          null
        }
        try {
          prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Claw, pendingSync = true, pendingScope = profile)
          val first = async { runtime.setProfileAppearancePreference("ui.theme", "claw") }
          withTimeout(2_000) { firstWriteStarted.await() }
          prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Dash, pendingSync = true, pendingScope = profile)
          val second = async { runtime.setProfileAppearancePreference("ui.theme", "dash") }
          releaseFirstWrite.complete(Unit)

          assertTrue(withTimeout(2_000) { first.await() })
          assertTrue(withTimeout(2_000) { second.await() })
          assertEquals(listOf("claw", "dash"), writes.map { it.entry("ui.theme") })
          assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
          assertTrue(prefs.pendingAppearancePreferenceEntries(profile).isEmpty())
        } finally {
          releaseFirstWrite.complete(Unit)
        }
      }
    }

  @Test
  fun readOnlyProfileRefreshPreservesAnotherProfilesPendingTheme() =
    runBlocking {
      withAppearanceGateway {
        val pendingScope = profileScope("profile-b")
        prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Dash, pendingSync = true, pendingScope = pendingScope)
        setProfilePreferences("profile-a", """{"ui.theme":"claw","ui.themeMode":"light"}""")
        connect(scopes = listOf("operator.read"))

        assertEquals(AppearanceThemeFamily.Claw, prefs.appearanceThemeFamily.value)
        assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
        assertEquals(mapOf("ui.theme" to "dash"), prefs.pendingAppearancePreferenceEntries(pendingScope))
        assertTrue(writes.isEmpty())
      }
    }

  @Test
  fun noDurableIdentityUsesGatewayThemeFallbacks() =
    runBlocking {
      withAppearanceGateway {
        prefs.setAppearanceAccentArgb(0xFF5A9BEFL)
        config = """{"ui":{"prefs":{"theme":"dash","themeMode":"light","accent":"#14B8A6"}}}"""
        connect(profileId = null)

        assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
        assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
        assertEquals(null, prefs.appearanceAccentArgb.value)
        assertEquals(0xFF14B8A6L, runtime.gatewayAccentArgb.value)
        assertEquals(null, runtime.appearancePreferenceScopeForEdit())
      }
    }

  @Test
  fun noDurableIdentityRetainsProfileEditUntilItsOwnerReconnects() =
    runBlocking {
      withAppearanceGateway {
        val profileA = profileScope("profile-a")
        prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Dash, pendingSync = true, pendingScope = profileA)
        viewModel().setAppearanceAccentArgb(0xFFE96CB7L)
        connect(profileId = null)

        assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
        assertEquals(mapOf("ui.theme" to "dash"), prefs.pendingAppearancePreferenceEntries(profileA))
        assertFalse(prefs.isAppearancePreferenceLocalOnly("ui.theme"))
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.accent"))

        connect(profileId = "profile-b")
        assertTrue(writes.isEmpty())
        assertEquals(AppearanceThemeFamily.Claw, prefs.appearanceThemeFamily.value)
        assertEquals(mapOf("ui.theme" to "dash"), prefs.pendingAppearancePreferenceEntries(profileA))

        connect(profileId = "profile-a")
        assertEquals(listOf("profile-a" to "dash"), writes.map { it.profileId to it.entry("ui.theme") })
        assertTrue(prefs.pendingAppearancePreferenceEntries(profileA).isEmpty())
        assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
      }
    }

  @Test
  fun unavailableProfileReadPreservesExistingAppearance() =
    runBlocking {
      withAppearanceGateway {
        setProfilePreferences("profile-a", """{"ui.theme":"tide","ui.themeMode":"dark","ui.accent":"#5A9BEF"}""")
        connect()
        config = """{"ui":{"prefs":{"theme":"dash","themeMode":"light","accent":"#14B8A6"}}}"""
        for (payload in listOf(JsonPrimitive("not-json").toString(), """{"status":"ok"}""", """{"status":"unavailable"}""")) {
          respond = { request -> payload.takeIf { request.method == "users.prefs.get" } }
          refresh()
          assertEquals(AppearanceThemeFamily.Tide, prefs.appearanceThemeFamily.value)
          assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
          assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
          assertEquals(0xFF5A9BEFL, runtime.gatewayAccentArgb.value)
        }

        setProfilePreferences("profile-b", """{"ui.theme":"rose","ui.themeMode":"light","ui.accent":"#E96CB7"}""")
        respond = { request ->
          if (request.method == "users.self") {
            throw GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "Profile lookup temporarily unavailable"))
          }
          null
        }
        connect(profileId = "profile-b")

        assertEquals(AppearanceThemeFamily.Tide, prefs.appearanceThemeFamily.value)
        assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
        assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
        assertEquals(null, runtime.appearancePreferenceScopeForEdit())
      }
    }

  @Test
  fun unverifiedReplacementEditsStayLocalWhenProfileLookupFails() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val viewModel = viewModel()
        val profileA = profileScope("profile-a")
        val replacementHelloStarted = CompletableDeferred<Unit>()
        val releaseReplacementHello = CompletableDeferred<Unit>()
        val profileLookupStarted = CompletableDeferred<Unit>()
        val releaseProfileLookup = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.profileId == "profile-b") {
            when (request.method) {
              "connect" -> {
                replacementHelloStarted.complete(Unit)
                releaseReplacementHello.await()
              }

              "users.self" -> {
                profileLookupStarted.complete(Unit)
                releaseProfileLookup.await()
                throw GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "Profile lookup temporarily unavailable"))
              }
            }
          }
          null
        }
        try {
          val replacement = async { connect(profileId = "profile-b") }
          withTimeout(APPEARANCE_CONNECTION_TIMEOUT_MS) { replacementHelloStarted.await() }
          assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
          viewModel.setAppearanceThemeFamily(AppearanceThemeFamily.Rose)
          assertEquals(mapOf("ui.theme" to "rose"), prefs.pendingAppearancePreferenceEntries(profileA))

          releaseReplacementHello.complete(Unit)
          withTimeout(APPEARANCE_CONNECTION_TIMEOUT_MS) { profileLookupStarted.await() }
          assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
          viewModel.setAppearanceThemeMode(AppearanceThemeMode.Light)
          releaseProfileLookup.complete(Unit)
          replacement.await()
          assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
          viewModel.setAppearanceAccentArgb(0xFF5A9BEFL)

          connect(profileId = "profile-a")

          assertEquals(
            "Only A's pre-hello edit may sync after returning from unverified B",
            listOf("profile-a" to "rose"),
            writes.map { it.profileId to it.entry("ui.theme") },
          )
          assertTrue(prefs.pendingAppearancePreferenceEntries(profileA).isEmpty())
          assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.themeMode"))
          assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.accent"))
          assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
          assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
        } finally {
          releaseReplacementHello.complete(Unit)
          releaseProfileLookup.complete(Unit)
        }
      }
    }

  @Test
  fun olderGatewayWithoutProfilePreferencesUsesConfigFallbacks() =
    runBlocking {
      for (catalogOmitsMethod in listOf(true, false)) {
        withAppearanceGateway {
          prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Tide)
          prefs.setAppearanceThemeMode(AppearanceThemeMode.Dark)
          config = """{"ui":{"prefs":{"theme":"dash","themeMode":"light","accent":"#14B8A6"}}}"""
          val unsupportedMethods = if (catalogOmitsMethod) setOf("config.get") else null
          val unsupportedPreferences: suspend (AppearanceRpcRequest) -> String? = { request ->
            if (request.method == "users.prefs.get") {
              throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unknown method: users.prefs.get"))
            }
            null
          }
          respond = unsupportedPreferences
          connect(methods = unsupportedMethods)

          assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
          assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
          assertEquals(0xFF14B8A6L, runtime.gatewayAccentArgb.value)
          assertEquals(if (catalogOmitsMethod) 0 else 1, requests.count { it.method == "users.prefs.get" })

          for (readOnly in listOf(false, true)) {
            respond = { null }
            connect(scopes = if (readOnly) listOf("operator.read") else listOf("operator.read", "operator.write"))
            respond = unsupportedPreferences
            connect(profileId = "profile-b", methods = unsupportedMethods)

            assertEquals(null, runtime.appearancePreferenceScopeForEdit())
          }
        }
      }
    }

  @Test
  fun readOnlyViewModelAppearanceChangesStayLocal() =
    runBlocking {
      withAppearanceGateway {
        connect(scopes = listOf("operator.read"))
        val viewModel = viewModel()
        viewModel.setAppearanceThemeFamily(AppearanceThemeFamily.Dash)
        viewModel.setAppearanceThemeMode(AppearanceThemeMode.Dark)
        viewModel.setAppearanceAccentArgb(0xFFE96CB7L)
        repeat(2) { refresh() }

        assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
        assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
        assertEquals(0xFFE96CB7L, prefs.appearanceAccentArgb.value)
        for (key in listOf("ui.theme", "ui.themeMode", "ui.accent")) {
          assertTrue(prefs.isAppearancePreferenceLocalOnly(key))
        }
        assertTrue(writes.isEmpty())
        assertTrue(prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isEmpty())

        connect()
        viewModel.setAppearanceThemeFamily(AppearanceThemeFamily.Tide)
        withTimeout(2_000) {
          while (writes.size != 1 || prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isNotEmpty()) yield()
        }
        assertEquals(AppearanceThemeFamily.Tide, prefs.appearanceThemeFamily.value)
        assertFalse(prefs.isAppearancePreferenceLocalOnly("ui.theme"))
      }
    }

  @Test
  fun unverifiedViewModelAppearanceEditsStayLocalUntilExplicitlyChangedOnline() =
    runBlocking {
      for (attachRuntime in listOf(false, true)) {
        withAppearanceGateway {
          viewModel(attachRuntime).setAppearanceThemeFamily(AppearanceThemeFamily.Dash)

          assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
          assertTrue(prefs.pendingAppearancePreferenceKeysForGateway(endpoint.stableId).isEmpty())
          assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.theme"))
          connect()
          assertTrue(writes.isEmpty())
          assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)

          viewModel().setAppearanceThemeFamily(AppearanceThemeFamily.Tide)
          withTimeout(2_000) {
            while (writes.size != 1 || prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isNotEmpty()) yield()
          }
          assertEquals(listOf("tide"), writes.map { it.entry("ui.theme") })
          assertFalse(prefs.isAppearancePreferenceLocalOnly("ui.theme"))
        }
      }
    }

  @Test
  fun offlineViewModelEditsRemainWithTheLastConfirmedProfile() =
    runBlocking {
      withAppearanceGateway {
        setProfilePreferences("profile-b", """{"ui.themeMode":"dark","ui.accent":"#e96cb7"}""")
        setProfilePreferences("profile-a", """{"ui.themeMode":"dark","ui.accent":"#14b8a6"}""")
        connect(profileId = "profile-b")
        val viewModel = viewModel()
        val replacementHelloStarted = CompletableDeferred<Unit>()
        val releaseReplacementHello = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.method == "connect" && request.profileId == "profile-a") {
            replacementHelloStarted.complete(Unit)
            releaseReplacementHello.await()
          }
          null
        }
        try {
          val replacement = async { connect(profileId = "profile-a") }
          withTimeout(APPEARANCE_CONNECTION_TIMEOUT_MS) { replacementHelloStarted.await() }
          assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
          viewModel.setAppearanceThemeMode(AppearanceThemeMode.Light)
          viewModel.setAppearanceAccentArgb(0xFF5A9BEFL)
          releaseReplacementHello.complete(Unit)
          replacement.await()

          val pending = mapOf("ui.themeMode" to "light", "ui.accent" to "#5a9bef")
          assertEquals("Profile A must not receive offline edits made for B", emptyList<AppearanceRpcRequest>(), writes)
          assertEquals(pending, prefs.pendingAppearancePreferenceEntries(profileScope("profile-b")))
          assertTrue(prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isEmpty())
          assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
          assertEquals(0xFF14B8A6L, prefs.appearanceAccentArgb.value)

          connect(profileId = "profile-b")
          assertEquals(listOf("profile-b", "profile-b"), writes.map { it.profileId })
          assertEquals(
            pending,
            writes
              .flatMap {
                it.params
                  .getValue("entries")
                  .jsonObject.entries
              }.associate { it.key to it.value.jsonPrimitive.content },
          )
          assertTrue(prefs.pendingAppearancePreferenceEntries(profileScope("profile-b")).isEmpty())
          assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
          assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
        } finally {
          releaseReplacementHello.complete(Unit)
        }
      }
    }

  @Test
  fun offlineViewModelEditsKeepKnownDeviceLocalPolicy() =
    runBlocking {
      val identities =
        listOf(
          "profile-b" to listOf("operator.read"),
          null to listOf("operator.read", "operator.write"),
        )
      for ((profileId, scopes) in identities) {
        withAppearanceGateway {
          setProfilePreferences("profile-a", """{"ui.themeMode":"dark","ui.accent":"#14b8a6"}""")
          connect(profileId = profileId, scopes = scopes)
          val viewModel = viewModel()
          viewModel.setAppearanceThemeMode(AppearanceThemeMode.Dark)
          viewModel.setAppearanceAccentArgb(0xFFE96CB7L)
          val replacementHelloStarted = CompletableDeferred<Unit>()
          val releaseReplacementHello = CompletableDeferred<Unit>()
          respond = { request ->
            if (request.method == "connect" && request.profileId == "profile-a") {
              replacementHelloStarted.complete(Unit)
              releaseReplacementHello.await()
            }
            null
          }
          try {
            val replacement = async { connect(profileId = "profile-a") }
            withTimeout(APPEARANCE_CONNECTION_TIMEOUT_MS) { replacementHelloStarted.await() }
            assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
            viewModel.setAppearanceThemeMode(AppearanceThemeMode.Light)
            viewModel.setAppearanceAccentArgb(0xFF5A9BEFL)
            releaseReplacementHello.complete(Unit)
            replacement.await()

            assertEquals(
              "Device-local edits must stay local after $profileId/$scopes disconnects",
              emptyList<AppearanceRpcRequest>(),
              writes,
            )
            for (key in listOf("ui.themeMode", "ui.accent")) {
              assertTrue(prefs.isAppearancePreferenceLocalOnly(key))
            }
            assertTrue(prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isEmpty())
            assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
            assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
          } finally {
            releaseReplacementHello.complete(Unit)
          }
        }
      }
    }

  @Test
  fun recreatedRuntimeDoesNotAdoptOfflineEditsIntoAnotherProfile() =
    runBlocking {
      withAppearanceGateway {
        connect(profileId = "profile-b")
        recreateOffline()
        assertEquals(endpoint.stableId, prefs.gatewayRegistry.activeStableId.value)
        assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
        val viewModel = viewModel()
        viewModel.setAppearanceThemeMode(AppearanceThemeMode.Light)
        viewModel.setAppearanceAccentArgb(0xFF5A9BEFL)
        connect(profileId = "profile-a")

        assertEquals("A fresh runtime must not assign offline edits to a different profile", emptyList<AppearanceRpcRequest>(), writes)

        viewModel.setAppearanceThemeFamily(AppearanceThemeFamily.Rose)
        withTimeout(2_000) {
          while (writes.size != 1 || prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isNotEmpty()) yield()
        }
        assertEquals(listOf("profile-a" to "rose"), writes.map { it.profileId to it.entry("ui.theme") })
      }
    }

  @Test
  fun recreatedRuntimeRetainsPreviouslyProfileBoundEdits() =
    runBlocking {
      withAppearanceGateway {
        connect(profileId = "profile-b")
        runtime.disconnect()
        viewModel().setAppearanceThemeFamily(AppearanceThemeFamily.Rose)
        recreateOffline()
        val profileB = profileScope("profile-b")

        assertEquals(mapOf("ui.theme" to "rose"), prefs.pendingAppearancePreferenceEntries(profileB))
        connect(profileId = "profile-a")
        assertTrue(writes.isEmpty())
        assertEquals(mapOf("ui.theme" to "rose"), prefs.pendingAppearancePreferenceEntries(profileB))

        connect(profileId = "profile-b")
        assertEquals(listOf("profile-b" to "rose"), writes.map { it.profileId to it.entry("ui.theme") })
        assertTrue(prefs.pendingAppearancePreferenceEntries(profileB).isEmpty())
        assertEquals(AppearanceThemeFamily.Rose, prefs.appearanceThemeFamily.value)
      }
    }

  @Test
  fun readOnlyLocalEditKeepsAnotherProfilesQueuedThemeAfterRecreation() =
    runBlocking {
      withAppearanceGateway {
        connect(profileId = "profile-a")
        disconnect()
        viewModel().setAppearanceThemeFamily(AppearanceThemeFamily.Dash)
        val profileA = profileScope("profile-a")
        val pending = mapOf("ui.theme" to "dash")
        assertEquals(pending, prefs.pendingAppearancePreferenceEntries(profileA))

        connect(profileId = "profile-b", scopes = listOf("operator.read"))
        viewModel().setAppearanceThemeFamily(AppearanceThemeFamily.Rose)
        recreateOffline()

        assertTrue(writes.isEmpty())
        assertEquals(pending, prefs.pendingAppearancePreferenceEntries(profileA))
        assertEquals(AppearanceThemeFamily.Rose, prefs.appearanceThemeFamily.value)
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.theme"))

        connect(profileId = "profile-a")
        refresh()

        assertEquals(listOf("profile-a" to "dash"), writes.map { it.profileId to it.entry("ui.theme") })
        assertTrue(prefs.pendingAppearancePreferenceEntries(profileA).isEmpty())
        assertEquals(AppearanceThemeFamily.Rose, prefs.appearanceThemeFamily.value)
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.theme"))
      }
    }

  @Test
  fun recreatedRuntimeKeepsOfflineReadOnlyEditsDeviceLocal() =
    runBlocking {
      withAppearanceGateway {
        connect(profileId = "profile-b", scopes = listOf("operator.read"))
        viewModel().apply {
          setAppearanceThemeMode(AppearanceThemeMode.Dark)
          setAppearanceAccentArgb(0xFFE96CB7L)
        }
        recreateOffline()
        assertEquals(endpoint.stableId, prefs.gatewayRegistry.activeStableId.value)
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.themeMode"))
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.accent"))
        assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
        viewModel().apply {
          setAppearanceThemeMode(AppearanceThemeMode.Light)
          setAppearanceAccentArgb(0xFF5A9BEFL)
        }
        connect(profileId = "profile-a")

        assertEquals("Recreation must not make device-local edits syncable", emptyList<AppearanceRpcRequest>(), writes)
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.themeMode"))
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.accent"))
        assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
        assertEquals(0xFF5A9BEFL, prefs.appearanceAccentArgb.value)
      }
    }

  @Test
  fun legacyThemeModeRemainsDeviceLocalAcrossWritableProfileRefresh() =
    runBlocking {
      withAppearanceGateway(legacyThemeMode = AppearanceThemeMode.Light) {
        setProfilePreferences("profile-a", """{"ui.themeMode":"dark"}""")
        connect()

        assertTrue(writes.isEmpty())
        assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
        assertTrue(prefs.isAppearancePreferenceLocalOnly("ui.themeMode"))
        assertTrue(prefs.pendingAppearancePreferenceEntries(profileScope("profile-a")).isEmpty())
      }
    }

  @Test
  fun missingProfileAccentKeepsGatewayFallbackOutOfTheLocalOverride() =
    runBlocking {
      withAppearanceGateway {
        prefs.setAppearanceAccentArgb(0xFF5A9BEFL)
        config = """{"ui":{"prefs":{"accent":"#14B8A6"}}}"""
        connect()

        assertEquals(null, prefs.appearanceAccentArgb.value)
        assertEquals(0xFF14B8A6L, runtime.gatewayAccentArgb.value)
      }
    }

  @Test
  fun olderProfileRefreshCannotOverwriteNewerAppearance() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val firstConfigStarted = CompletableDeferred<Unit>()
        val releaseFirstConfig = CompletableDeferred<Unit>()
        val configReads = AtomicInteger()
        val preferenceReads = AtomicInteger()
        respond = { request ->
          when (request.method) {
            "config.get" -> {
              if (configReads.incrementAndGet() == 1) {
                firstConfigStarted.complete(Unit)
                releaseFirstConfig.await()
              }
              null
            }

            "users.prefs.get" -> {
              if (preferenceReads.incrementAndGet() == 1) {
                """{"status":"ok","entries":{"ui.theme":"dash","ui.themeMode":"dark"}}"""
              } else {
                """{"status":"ok","entries":{"ui.theme":"claw","ui.themeMode":"light"}}"""
              }
            }

            else -> {
              null
            }
          }
        }
        try {
          val older = async { refresh() }
          withTimeout(2_000) { firstConfigStarted.await() }
          refresh()
          releaseFirstConfig.complete(Unit)
          withTimeout(2_000) { older.await() }

          assertEquals(AppearanceThemeFamily.Dash, prefs.appearanceThemeFamily.value)
          assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
        } finally {
          releaseFirstConfig.complete(Unit)
        }
      }
    }

  @Test
  fun brandingRefreshPropagatesCancellation() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val configRead = CompletableDeferred<Unit>()
        val releaseConfig = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.method == "config.get") {
            configRead.complete(Unit)
            releaseConfig.await()
          }
          null
        }
        var returnedNormally = false
        val pendingRefresh =
          launch {
            refresh()
            returnedNormally = true
          }
        try {
          withTimeout(2_000) { configRead.await() }
          pendingRefresh.cancel(CancellationException("refresh cancelled"))
          withTimeout(2_000) { pendingRefresh.join() }
          assertFalse(returnedNormally)
        } finally {
          releaseConfig.complete(Unit)
        }
      }
    }

  @Test
  fun completedWriteCannotOverwriteANewerProfileOwner() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val profileA = profileScope("profile-a")
        val writeStarted = CompletableDeferred<Unit>()
        val releaseWrite = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.method == "users.prefs.set") {
            writeStarted.complete(Unit)
            releaseWrite.await()
          }
          null
        }
        try {
          prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Dash, pendingSync = true, pendingScope = profileA)
          val write = async { runtime.setProfileAppearancePreference("ui.theme", "dash") }
          withTimeout(2_000) { writeStarted.await() }
          changeCurrentProfile("profile-b")
          refresh()
          releaseWrite.complete(Unit)

          assertTrue(withTimeout(2_000) { write.await() })
          assertEquals(AppearanceThemeFamily.Claw, prefs.appearanceThemeFamily.value)
          assertEquals(mapOf("ui.theme" to "dash"), prefs.pendingAppearancePreferenceEntries(profileA))
        } finally {
          releaseWrite.complete(Unit)
        }
      }
    }

  @Test
  fun reconnectDoesNotWriteAPreviousProfilesPendingPreferenceOnTheNewSocket() =
    runBlocking {
      withAppearanceGateway {
        connect()
        val profileA = profileScope("profile-a")
        prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Rose, pendingSync = true, pendingScope = profileA)
        val secondBrandingRead = CompletableDeferred<Unit>()
        val releaseBranding = CompletableDeferred<Unit>()
        respond = { request ->
          if (request.method == "config.get" && request.profileId == "profile-b") {
            secondBrandingRead.complete(Unit)
            releaseBranding.await()
          }
          null
        }
        try {
          connect(profileId = "profile-b", waitForBranding = false)
          withTimeout(2_000) { secondBrandingRead.await() }
          val written = withTimeout(2_000) { runtime.setProfileAppearancePreference("ui.theme", "rose") }

          assertEquals("The new socket must not receive another profile's queued edit", emptyList<AppearanceRpcRequest>(), writes)
          assertFalse(written)
          assertEquals(mapOf("ui.theme" to "rose"), prefs.pendingAppearancePreferenceEntries(profileA))
        } finally {
          releaseBranding.complete(Unit)
        }
      }
    }
}

private suspend fun withAppearanceGateway(
  legacyThemeMode: AppearanceThemeMode? = null,
  block: suspend AppearanceGatewayFixture.() -> Unit,
) {
  val fixture = AppearanceGatewayFixture(legacyThemeMode)
  try {
    fixture.block()
  } finally {
    fixture.close()
  }
}

private data class AppearanceRpcRequest(
  val connection: Int,
  val profileId: String?,
  val method: String,
  val params: JsonObject,
) {
  fun entry(key: String): String? =
    params["entries"]
      ?.jsonObject
      ?.get(key)
      ?.takeIf { it !is JsonNull }
      ?.jsonPrimitive
      ?.content
}

private class AppearanceGatewayFixture(
  legacyThemeMode: AppearanceThemeMode?,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val app = RuntimeEnvironment.getApplication() as NodeApp
  private val securePreferences = app.getSharedPreferences("appearance-runtime-" + UUID.randomUUID(), Context.MODE_PRIVATE)
  private val server = MockWebServer()
  private val workers = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val sequence = AtomicInteger()
  private val brandingFinished = MutableStateFlow(0)
  private val profiles = ConcurrentHashMap<String, JsonObject>()
  private val connections = ConcurrentHashMap<Int, Connection>()
  private val models = ViewModelStore()

  private class Connection(
    @Volatile var profileId: String?,
    val scopes: List<String>,
    val methods: Set<String>?,
  ) {
    val operatorHello = CompletableDeferred<Int>()
  }

  @Volatile private var nextConnection =
    Connection("profile-a", listOf("operator.read", "operator.write"), appearanceMethods)

  @Volatile var config = "{}"

  @Volatile var respond: suspend (AppearanceRpcRequest) -> String? = { null }
  val requests = CopyOnWriteArrayList<AppearanceRpcRequest>()
  val writes: List<AppearanceRpcRequest> get() = requests.filter { it.method == "users.prefs.set" }
  var prefs: SecurePrefs
    private set

  var runtime: NodeRuntime
    private set

  val endpoint: GatewayEndpoint
  private var session: GatewaySession
  private var connected = false

  init {
    app.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE).edit().apply {
      clear()
      legacyThemeMode?.let { putString("appearance.themeMode", it.rawValue) }
      commit()
    }
    prefs = SecurePrefs(app, securePreferences)
    runtime = NodeRuntime(app, prefs)
    session = ReflectionHelpers.getField(runtime, "operatorSession")
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          if (!request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) return MockResponse().setResponseCode(404)
          val number = sequence.incrementAndGet()
          val identity = nextConnection
          connections[number] = identity
          return MockResponse().withWebSocketUpgrade(listener(number, identity))
        }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  suspend fun connect(
    profileId: String? = "profile-a",
    scopes: List<String> = listOf("operator.read", "operator.write"),
    methods: Set<String>? = appearanceMethods,
    waitForBranding: Boolean = true,
  ) {
    if (!connected) stopStartupJobs()
    val identity = Connection(profileId, scopes, methods)
    nextConnection = identity
    if (!connected) {
      ReflectionHelpers.setField(runtime, "connectedEndpoint", endpoint)
      val manager = ReflectionHelpers.getField<ConnectionManager>(runtime, "connectionManager")
      session.connect(endpoint, "synthetic-appearance-proof", null, null, manager.buildOperatorConnectOptions())
      connected = true
    } else {
      session.reconnect()
    }
    withTimeout(APPEARANCE_CONNECTION_TIMEOUT_MS) {
      // Startup can open both role sockets; observe this operator hello instead of predicting the next upgrade.
      val number = identity.operatorHello.await()
      runtime.serverName.first { it == "appearance-$number" }
      if (waitForBranding) brandingFinished.first { it >= number }
    }
  }

  suspend fun disconnect() {
    runtime.disconnect()
    session.disconnectAndJoin()
    connected = false
  }

  suspend fun recreateOffline() {
    models.clear()
    session.disconnectAndJoin()
    closeNodeRuntimeTestFixture(runtime)
    val previousRespond = respond
    respond = { request ->
      if (request.method == "connect") {
        throw GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "Gateway offline"))
      }
      previousRespond(request)
    }
    try {
      prefs = SecurePrefs(app, securePreferences)
      runtime = NodeRuntime(app, prefs)
      session = ReflectionHelpers.getField(runtime, "operatorSession")
      runtime.disconnect()
      stopStartupJobs()
      connected = false
    } finally {
      respond = previousRespond
    }
  }

  private suspend fun stopStartupJobs() {
    // Match the established runtime fixture: stop discovery before it can open
    // extra sockets, keeping the normal session callbacks and their IO alive.
    val startupJobs =
      ReflectionHelpers
        .getField<CoroutineScope>(runtime, "scope")
        .coroutineContext.job.children
        .toList()
    startupJobs.forEach { it.cancel() }
    startupJobs.joinAll()
    session.disconnectAndJoin()
    ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession").disconnectAndJoin()
  }

  fun profileScope(profileId: String?) = AppearancePreferenceScope(endpoint.stableId, profileId)

  fun setProfilePreferences(
    profileId: String,
    entries: String,
  ) {
    profiles[profileId] = json.parseToJsonElement(entries).jsonObject
  }

  fun changeCurrentProfile(profileId: String?) {
    connections.getValue(sequence.get()).profileId = profileId
  }

  fun viewModel(attachRuntime: Boolean = true): MainViewModel =
    MainViewModel(app, prefs, SavedStateHandle()).also { viewModel ->
      if (attachRuntime) ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      models.put("appearance", viewModel)
    }

  suspend fun refresh() {
    try {
      suspendCoroutineUninterceptedOrReturn<Unit> { continuation ->
        NodeRuntime::class.java
          .getDeclaredMethod("refreshBrandingFromGateway", Continuation::class.java)
          .apply { isAccessible = true }
          .invoke(runtime, continuation)
      }
    } catch (wrapped: InvocationTargetException) {
      throw wrapped.targetException
    }
  }

  private fun listener(
    number: Int,
    identity: Connection,
  ) = object : WebSocketListener() {
    override fun onOpen(
      webSocket: WebSocket,
      response: Response,
    ) {
      webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"appearance-proof","ts":1700000000123}}""")
    }

    override fun onMessage(
      webSocket: WebSocket,
      text: String,
    ) {
      val frame = json.parseToJsonElement(text).jsonObject
      if (frame["type"]?.jsonPrimitive?.content != "req") return
      val id = checkNotNull(frame["id"])
      val request =
        AppearanceRpcRequest(
          connection = number,
          profileId = identity.profileId,
          method = checkNotNull(frame["method"]).jsonPrimitive.content,
          params = frame["params"] as? JsonObject ?: JsonObject(emptyMap()),
        )
      requests += request
      // The connected callback requests voicewake only after branding returns.
      // This observes completion without replacing the appearance publication owner.
      if (request.method == "voicewake.get") brandingFinished.value = number
      workers.launch {
        try {
          val payload = respond(request) ?: response(request, identity)
          val sent = webSocket.send("""{"type":"res","id":$id,"ok":true,"payload":$payload}""")
          if (sent && request.method == "connect" && request.params["role"]?.jsonPrimitive?.content == "operator") {
            identity.operatorHello.complete(number)
          }
        } catch (error: GatewayRequestRejected) {
          val code = JsonPrimitive(error.gatewayError.code)
          val message = JsonPrimitive(error.gatewayError.message)
          webSocket.send("""{"type":"res","id":$id,"ok":false,"error":{"code":$code,"message":$message}}""")
        }
      }
    }

    override fun onClosing(
      webSocket: WebSocket,
      code: Int,
      reason: String,
    ) {
      webSocket.close(code, reason)
    }
  }

  private fun response(
    request: AppearanceRpcRequest,
    identity: Connection,
  ): String =
    when (request.method) {
      "connect" -> {
        buildJsonObject {
          put("server", buildJsonObject { put("host", JsonPrimitive("appearance-" + request.connection)) })
          identity.methods?.let { methods ->
            put("features", buildJsonObject { put("methods", JsonArray(methods.map(::JsonPrimitive))) })
          }
          put(
            "auth",
            buildJsonObject {
              put("role", JsonPrimitive("operator"))
              put("scopes", JsonArray(identity.scopes.map(::JsonPrimitive)))
            },
          )
          put("snapshot", json.parseToJsonElement("""{"sessionDefaults":{"mainSessionKey":"main"}}"""))
        }.toString()
      }

      "config.get" -> {
        """{"config":$config}"""
      }

      "users.prefs.get" -> {
        if (request.profileId == null) {
          """{"status":"no_durable_identity"}"""
        } else {
          val entries = profiles[request.profileId] ?: JsonObject(emptyMap())
          """{"status":"ok","entries":$entries}"""
        }
      }

      "users.self" -> {
        requireWriteScope(identity)
        val id = request.profileId?.let(::JsonPrimitive) ?: JsonNull
        """{"profile":{"id":$id}}"""
      }

      "users.prefs.set" -> {
        requireWriteScope(identity)
        val profileId = checkNotNull(request.profileId)
        val entries = request.params.getValue("entries").jsonObject
        profiles.compute(profileId) { _, previous ->
          JsonObject((previous.orEmpty() + entries).filterValues { it !is JsonNull })
        }
        """{"status":"ok"}"""
      }

      else -> {
        "{}"
      }
    }

  private fun requireWriteScope(identity: Connection) {
    if ("operator.write" !in identity.scopes) {
      throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "missing scope: operator.write"))
    }
  }

  suspend fun close() {
    models.clear()
    try {
      session.disconnectAndJoin()
    } finally {
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        workers.coroutineContext.job.cancelAndJoin()
        server.shutdown()
      }
    }
  }

  companion object {
    private val appearanceMethods = setOf("config.get", "users.self", "users.prefs.get", "users.prefs.set")
  }
}
