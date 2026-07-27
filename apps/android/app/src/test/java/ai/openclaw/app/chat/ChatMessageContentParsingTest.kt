package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.readBoundedWidgetDocument
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatMessageContentParsingTest {
  @Test
  fun boundedWidgetDocumentReadAcceptsAtMostLimitAndRejectsOverflow() {
    assertArrayEquals(
      byteArrayOf(1, 2),
      readBoundedWidgetDocument(Buffer().write(byteArrayOf(1, 2)), maxBytes = 3),
    )
    assertArrayEquals(
      byteArrayOf(1, 2, 3),
      readBoundedWidgetDocument(Buffer().write(byteArrayOf(1, 2, 3)), maxBytes = 3),
    )
    assertNull(readBoundedWidgetDocument(Buffer().write(byteArrayOf(1, 2, 3, 4)), maxBytes = 3))
  }

  @Test
  fun dropsInternalToolBlocksFromDisplayHistory() {
    val content =
      Json.parseToJsonElement(
        """{"type":"toolResult","content":"large internal output"}""",
      )

    assertNull(parseChatMessageContent(content))
  }

  @Test
  fun parsesCodexTextBlocksAsVisibleText() {
    val content =
      Json.parseToJsonElement(
        """{"type":"output_text","text":"Done."}""",
      )

    assertEquals(ChatMessageContent(type = "text", text = "Done."), parseChatMessageContent(content))
  }

  @Test
  fun parsesCapabilityGatedCanvasWidgets() {
    val content =
      Json.parseToJsonElement(
        """{"type":"canvas","preview":{"kind":"canvas","surface":"assistant_message","render":"url","title":"Status","preferredHeight":240,"url":"/__openclaw__/canvas/documents/widget-1/index.html","sandbox":"scripts"}}""",
      )

    assertEquals(
      ChatMessageContent(
        type = "canvas",
        widget =
          ChatWidgetPreview(
            title = "Status",
            path = "/__openclaw__/canvas/documents/widget-1/index.html",
            preferredHeight = 240,
            sandbox = "scripts",
          ),
      ),
      parseChatMessageContent(content),
    )
  }

  @Test
  fun dropsCanvasBlocksWithoutWidgetSandbox() {
    val content =
      Json.parseToJsonElement(
        """{"type":"canvas","preview":{"kind":"canvas","surface":"assistant_message","render":"url","url":"/__openclaw__/canvas/documents/widget-1/index.html"}}""",
      )

    assertNull(parseChatMessageContent(content))
  }

  @Test
  fun dropsCanvasBlocksWithUntrustedWidgetTargets() {
    val content =
      Json.parseToJsonElement(
        """{"type":"canvas","preview":{"kind":"canvas","surface":"assistant_message","render":"url","url":"https://attacker.example/widget.html","sandbox":"scripts"}}""",
      )

    assertNull(parseChatMessageContent(content))
  }

  @Test
  fun resolvesOnlyCapabilityScopedWidgetDocuments() {
    val surface = "https://gateway.example/__openclaw__/cap/token"

    assertEquals(
      "https://gateway.example/__openclaw__/cap/token/__openclaw__/canvas/documents/widget-1/index.html",
      ChatWidgetUrlResolver.resolve(surface, "/__openclaw__/canvas/documents/widget-1/index.html"),
    )
    assertEquals(
      "https://gateway.example/__openclaw__/cap/token/__openclaw__/canvas/documents/widget-1/index.html",
      ChatWidgetUrlResolver.resolve(
        "HTTPS://gateway.example/__openclaw__/cap/token",
        "/__openclaw__/canvas/documents/widget-1/index.html",
      ),
    )
    assertNull(ChatWidgetUrlResolver.resolve("https://gateway.example", "/__openclaw__/canvas/documents/widget-1/index.html"))
    assertNull(ChatWidgetUrlResolver.resolve(surface, "https://attacker.example/widget.html"))
    assertNull(ChatWidgetUrlResolver.resolve(surface, "/__openclaw__/a2ui/index.html"))
    assertNull(ChatWidgetUrlResolver.resolve(surface, "/__openclaw__/canvas/documents/%252e%252e/index.html"))
  }

  @Test
  fun initialResolutionUsesOperatorFallbackWhenNodeUnavailable() {
    val target = "/__openclaw__/canvas/documents/widget-1/index.html"
    val fallbackSurface = "https://operator.example/__openclaw__/cap/fallback"
    val surfaces =
      ChatWidgetSurfaceUrls(
        node = null,
        operator = ChatWidgetSurface(url = fallbackSurface, tlsFingerprintSha256 = null),
      )

    val resolved = ChatWidgetUrlResolver.resolvePreferred(surfaces, target, excluding = null)

    assertEquals(ChatWidgetUrlResolver.resolve(fallbackSurface, target), resolved?.url)
  }

  @Test
  fun usesReplacementRouteAfterCapabilityRefreshLosesItsLease() =
    runTest {
      val target = "/__openclaw__/canvas/documents/widget-1/index.html"
      val oldSurface = "https://gateway.example/__openclaw__/cap/old"
      val newSurface = "https://gateway.example/__openclaw__/cap/new"
      val oldPin = "aa".repeat(32)
      val newPin = "bb".repeat(32)
      val failedUrl = ChatWidgetUrlResolver.resolve(oldSurface, target)
      val failedResource = ChatWidgetResource(url = requireNotNull(failedUrl), tlsFingerprintSha256 = oldPin)
      var current =
        ChatWidgetSurfaceUrls(
          node = ChatWidgetSurface(url = oldSurface, tlsFingerprintSha256 = oldPin),
          operator = null,
        )

      val resolved =
        ChatWidgetUrlResolver.resolveAfterFailure(
          target = target,
          failedResource = failedResource,
          currentSurfaceUrls = { current },
          refreshNodeSurface = {
            current =
              ChatWidgetSurfaceUrls(
                node = ChatWidgetSurface(url = newSurface, tlsFingerprintSha256 = newPin),
                operator = null,
              )
            null
          },
          refreshOperatorSurface = { null },
        )

      assertEquals(ChatWidgetUrlResolver.resolve(newSurface, target), resolved?.url)
      assertEquals(newPin, resolved?.tlsFingerprintSha256)
    }

  @Test
  fun acceptsSameUrlReplacementWhenTlsPinChanged() =
    runTest {
      val target = "/__openclaw__/canvas/documents/widget-1/index.html"
      val surface = "https://gateway.example/__openclaw__/cap/token"
      val oldPin = "aa".repeat(32)
      val newPin = "bb".repeat(32)
      val url = requireNotNull(ChatWidgetUrlResolver.resolve(surface, target))
      val failedResource = ChatWidgetResource(url = url, tlsFingerprintSha256 = oldPin)
      var current =
        ChatWidgetSurfaceUrls(
          node = ChatWidgetSurface(url = surface, tlsFingerprintSha256 = oldPin),
          operator = null,
        )

      val resolved =
        ChatWidgetUrlResolver.resolveAfterFailure(
          target = target,
          failedResource = failedResource,
          currentSurfaceUrls = { current },
          refreshNodeSurface = {
            current =
              ChatWidgetSurfaceUrls(
                node = ChatWidgetSurface(url = surface, tlsFingerprintSha256 = newPin),
                operator = null,
              )
            null
          },
          refreshOperatorSurface = { null },
        )

      assertEquals(url, resolved?.url)
      assertEquals(newPin, resolved?.tlsFingerprintSha256)
    }

  @Test
  fun refreshesNodeOnceBeforeTryingOperatorFallback() =
    runTest {
      val target = "/__openclaw__/canvas/documents/widget-1/index.html"
      val oldSurface = "https://gateway.example/__openclaw__/cap/old"
      val newSurface = "https://gateway.example/__openclaw__/cap/new"
      val fallbackSurface = "https://operator.example/__openclaw__/cap/fallback"
      var refreshCount = 0
      var current =
        ChatWidgetSurfaceUrls(
          node = ChatWidgetSurface(url = oldSurface, tlsFingerprintSha256 = null),
          operator = ChatWidgetSurface(url = fallbackSurface, tlsFingerprintSha256 = null),
        )
      val initialNode = ChatWidgetUrlResolver.resolvePreferred(current, target, excluding = null)

      val refreshedNode =
        ChatWidgetUrlResolver.resolveAfterFailure(
          target = target,
          failedResource = requireNotNull(initialNode),
          currentSurfaceUrls = { current },
          refreshNodeSurface = {
            refreshCount += 1
            current = current.copy(node = ChatWidgetSurface(url = newSurface, tlsFingerprintSha256 = null))
            null
          },
          refreshOperatorSurface = { null },
        )

      assertEquals(ChatWidgetUrlResolver.resolve(newSurface, target), refreshedNode?.url)

      val fallback =
        ChatWidgetUrlResolver.resolveAfterFailure(
          target = target,
          failedResource = requireNotNull(refreshedNode),
          currentSurfaceUrls = { current },
          refreshNodeSurface = {
            refreshCount += 1
            null
          },
          refreshOperatorSurface = { null },
        )

      assertEquals(ChatWidgetUrlResolver.resolve(fallbackSurface, target), fallback?.url)
      assertEquals(1, refreshCount)
    }

  @Test
  fun refreshesOperatorCapabilityWhenNodeUnavailable() =
    runTest {
      val target = "/__openclaw__/canvas/documents/widget-1/index.html"
      val oldSurface = "https://operator.example/__openclaw__/cap/old"
      val newSurface = "https://operator.example/__openclaw__/cap/new"
      val failedResource =
        ChatWidgetResource(
          url = requireNotNull(ChatWidgetUrlResolver.resolve(oldSurface, target)),
          tlsFingerprintSha256 = null,
        )
      var operatorRefreshCount = 0
      var current =
        ChatWidgetSurfaceUrls(
          node = null,
          operator = ChatWidgetSurface(url = oldSurface, tlsFingerprintSha256 = null),
        )

      val resolved =
        ChatWidgetUrlResolver.resolveAfterFailure(
          target = target,
          failedResource = failedResource,
          currentSurfaceUrls = { current },
          refreshNodeSurface = { null },
          refreshOperatorSurface = {
            operatorRefreshCount += 1
            ChatWidgetSurface(url = newSurface, tlsFingerprintSha256 = null).also {
              current = current.copy(operator = it)
            }
          },
        )

      assertEquals(ChatWidgetUrlResolver.resolve(newSurface, target), resolved?.url)
      assertEquals(1, operatorRefreshCount)
    }

  @Test
  fun parsesImageBlocksOnlyWhenInlineContentExists() {
    val image =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"chart.png","content":"abc123"}""",
      )
    val managedImage =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"chart.png","url":"/api/chat/media/outgoing/main/id"}""",
      )

    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "chart.png", base64 = "abc123"),
      parseChatMessageContent(image),
    )
    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "chart.png", base64 = null),
      parseChatMessageContent(managedImage),
    )
  }

  @Test
  fun dropsOversizedInlineImageContentBeforeRendering() {
    val oversized = "A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)
    val image =
      Json.parseToJsonElement(
        """{"type":"image","mimeType":"image/png","fileName":"large.png","content":"$oversized"}""",
      )

    assertEquals(
      ChatMessageContent(type = "image", mimeType = "image/png", fileName = "large.png", base64 = null),
      parseChatMessageContent(image),
    )
  }

  @Test
  fun parsesDirectAndAttachmentAudioBlocks() {
    val direct =
      Json.parseToJsonElement(
        """{"type":"audio","mimeType":"audio/mp4","fileName":"voice.m4a"}""",
      )
    val attachment =
      Json.parseToJsonElement(
        """{"type":"attachment","attachment":{"kind":"audio","mimeType":"audio/mpeg","label":"reply.mp3"}}""",
      )

    assertEquals(
      ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice.m4a"),
      parseChatMessageContent(direct),
    )
    assertEquals(
      ChatMessageContent(type = "audio", mimeType = "audio/mpeg", fileName = "reply.mp3"),
      parseChatMessageContent(attachment),
    )
  }

  @Test
  fun parsesTranscriptAudioMediaFieldsAlongsideCaption() {
    val message =
      Json
        .parseToJsonElement(
          """{"content":[{"type":"text","text":"See attached."}],"MediaPaths":["media/inbound/voice.m4a"],"MediaTypes":["audio/x-m4a"]}""",
        ).jsonObject

    assertEquals(
      listOf(
        ChatMessageContent(type = "text", text = "See attached."),
        ChatMessageContent(type = "audio", mimeType = "audio/x-m4a", fileName = "voice.m4a"),
      ),
      parseChatMessageContents(message),
    )
  }
}
