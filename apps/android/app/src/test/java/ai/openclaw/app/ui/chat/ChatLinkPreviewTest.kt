package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.image.PublicOnlyDns
import ai.openclaw.app.ui.image.REMOTE_IMAGE_BODY_MAX_BYTES
import ai.openclaw.app.ui.image.REMOTE_IMAGE_MAX_DIMENSION
import ai.openclaw.app.ui.image.RemoteImageResult
import ai.openclaw.app.ui.image.SafeRemoteImageFetcher
import ai.openclaw.app.ui.image.SafeRemoteImageStore
import ai.openclaw.app.ui.image.SafeWebFetcher
import ai.openclaw.app.ui.image.decodeRemoteImageBitmap
import ai.openclaw.app.ui.image.isPubliclyRoutableHost
import ai.openclaw.app.ui.image.resolveRedirect
import android.graphics.Bitmap
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class ChatLinkPreviewTest {
  @Test
  fun extractsFirstHttpLinkOutsideCode() {
    assertEquals("https://example.com/path", extractFirstBareUrl("See https://example.com/path now"))
    assertEquals("https://example.com/docs", extractFirstBareUrl("Read [the docs](https://example.com/docs)"))
    assertEquals(
      "https://after.example",
      extractFirstBareUrl("`https://inline.example`\n```\nhttps://fenced.example\n```\nhttps://after.example"),
    )
  }

  @Test
  fun extractionSkipsMissingAndNonHttpLinks() {
    assertNull(extractFirstBareUrl("No URL here"))
    assertNull(extractFirstBareUrl("[mail](mailto:test@example.com) and ftp://example.com/file"))
  }

  @Test
  fun rejectsNonPublicLiteralAndLocalHosts() {
    val rejected =
      listOf(
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://172.20.1.1/",
        "http://192.168.1.1/",
        "http://169.254.9.9/",
        "http://100.64.0.1/",
        "http://198.18.0.1/",
        "http://192.0.2.1/",
        "http://0.0.0.0/",
        "http://224.0.0.1/",
        "http://255.255.255.255/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://[fc00::1]/",
        "http://[::]/",
        "http://[ff02::1]/",
        "http://[2001:db8::1]/",
        "http://localhost/",
        "http://foo.local/",
      )
    rejected.forEach { url ->
      assertTrue("Expected $url to be rejected", !isPubliclyRoutableHost(url.toHttpUrl()))
    }

    assertTrue(isPubliclyRoutableHost("https://example.com/".toHttpUrl()))
    assertTrue(isPubliclyRoutableHost("http://93.184.216.34/".toHttpUrl()))
    assertTrue(isPubliclyRoutableHost("https://[2606:4700:4700::1111]/".toHttpUrl()))
  }

  @Test
  fun dnsRejectsMixedPublicAndPrivateAnswers() {
    val answers =
      listOf(
        InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34)),
        InetAddress.getByAddress(byteArrayOf(10, 0, 0, 5)),
      )
    val dns = PublicOnlyDns(Dns { answers })

    assertTrue(runCatching { dns.lookup("example.com") }.exceptionOrNull() is UnknownHostException)
  }

  @Test
  fun privateLiteralInitialUrlFailsWithoutNetworkCall() =
    withServer { server ->
      server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<title>Private</title>"))

      assertSame(LinkPreviewResult.Failed, realPolicyFetcher().fetch(server.url("/private").toString()))
      assertEquals(0, server.requestCount)
    }

  @Test
  fun redirectPolicyRejectsPrivateLiteralTarget() {
    val target = resolveRedirect("https://example.com/start".toHttpUrl(), "http://127.0.0.1:1/private")

    assertNull(target)
  }

  @Test
  fun parsesOpenGraphWithAttributeOrderAndRelativeImage() {
    val result =
      parseOpenGraph(
        html =
          """
          <html><head>
          <meta content='A title' property='og:title'>
          <meta name="og:description" content="One &amp; two">
          <meta content=/images/card.png property=og:image>
          </head></html>
          """.trimIndent(),
        baseUrl = "https://example.com/articles/one",
      ) as LinkPreviewResult.Loaded

    assertEquals("A title", result.metadata.title)
    assertEquals("One & two", result.metadata.description)
    assertEquals("https://example.com/images/card.png", result.metadata.imageUrl)
  }

  @Test
  fun fallsBackToTitleAndFailsWhenMetadataIsMissing() {
    val fallback = parseOpenGraph("<html><title>Fallback title</title></html>", "https://example.com")

    assertEquals("Fallback title", (fallback as LinkPreviewResult.Loaded).metadata.title)
    assertSame(LinkPreviewResult.Failed, parseOpenGraph("<html><body>Nothing</body></html>", "https://example.com"))
  }

  @Test
  fun stripsControlsAndCapsMetadataLengths() {
    val title = "T\u0000" + "x".repeat(LINK_PREVIEW_TITLE_MAX_CHARS + 20)
    val description = "D\u0007" + "y".repeat(LINK_PREVIEW_DESCRIPTION_MAX_CHARS + 20)
    val result =
      parseOpenGraph(
        "<meta property='og:title' content='$title'><meta content=\"$description\" property=\"og:description\">",
        "https://example.com",
      ) as LinkPreviewResult.Loaded

    assertEquals(LINK_PREVIEW_TITLE_MAX_CHARS, result.metadata.title?.length)
    assertEquals(LINK_PREVIEW_DESCRIPTION_MAX_CHARS, result.metadata.description?.length)
    assertTrue(
      result.metadata.title
        .orEmpty()
        .none(Character::isISOControl),
    )
    assertTrue(
      result.metadata.description
        .orEmpty()
        .none(Character::isISOControl),
    )
  }

  @Test
  fun metadataTruncationPreservesUtf16Boundaries() {
    val titlePrefix = "t".repeat(LINK_PREVIEW_TITLE_MAX_CHARS - 1)
    val descriptionPrefix = "d".repeat(LINK_PREVIEW_DESCRIPTION_MAX_CHARS - 2)
    val result =
      parseOpenGraph(
        "<meta property='og:title' content='$titlePrefix\uD83D\uDE80 trailing'>" +
          "<meta property='og:description' content='$descriptionPrefix\uD83D\uDE80 trailing'>",
        "https://example.com",
      ) as LinkPreviewResult.Loaded

    assertEquals(titlePrefix, result.metadata.title)
    assertEquals("$descriptionPrefix\uD83D\uDE80", result.metadata.description)
  }

  @Test
  fun fetchesHtmlWithoutAmbientHeaders() =
    withServer { server ->
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .setBody("<meta property='og:title' content='Fetched'>"),
      )

      val result = fetcher().fetch(server.url("/page").toString()) as LinkPreviewResult.Loaded

      assertEquals("Fetched", result.metadata.title)
      val request = server.takeRequest()
      assertEquals("text/html, application/xhtml+xml;q=0.9", request.getHeader("Accept"))
      assertNull(request.getHeader("Cookie"))
      assertNull(request.getHeader("Authorization"))
    }

  @Test
  fun followsThreeRedirectsButRejectsAFourth() {
    withServer { server ->
      repeat(3) { index -> server.enqueue(redirect("/hop${index + 1}")) }
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/html")
          .setBody("<title>After three</title>"),
      )

      val loaded = fetcher().fetch(server.url("/start").toString()) as LinkPreviewResult.Loaded
      assertEquals("After three", loaded.metadata.title)
      assertEquals(4, server.requestCount)
    }

    withServer { server ->
      repeat(4) { index -> server.enqueue(redirect("/hop${index + 1}")) }
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/html")
          .setBody("<title>Too far</title>"),
      )

      assertSame(LinkPreviewResult.Failed, fetcher().fetch(server.url("/start").toString()))
      assertEquals(4, server.requestCount)
    }
  }

  @Test
  fun parsesOnlyTheFirst512KiB() =
    withServer { server ->
      val prefix = "<meta property='og:title' content='Early'>"
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/html")
          .setBody(prefix + "x".repeat(LINK_PREVIEW_BODY_MAX_BYTES + 1_024)),
      )

      val result = fetcher().fetch(server.url("/large").toString()) as LinkPreviewResult.Loaded

      assertEquals("Early", result.metadata.title)
    }

  @Test
  fun rejectsNonHtmlAndTimesOutQuickly() {
    withServer { server ->
      server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{}"))
      assertSame(LinkPreviewResult.Failed, fetcher().fetch(server.url("/json").toString()))
    }

    withServer { server ->
      server.enqueue(
        MockResponse()
          .setHeadersDelay(500, TimeUnit.MILLISECONDS)
          .setHeader("Content-Type", "text/html")
          .setBody("<title>Late</title>"),
      )
      assertSame(LinkPreviewResult.Failed, fetcher(timeoutMillis = 75).fetch(server.url("/slow").toString()))
    }
  }

  @Test
  fun responseBodyDisconnectReturnsFailed() =
    withServer { server ->
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "text/html")
          .setBody("x".repeat(16_384) + "<title>Never complete</title>")
          .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
      )

      assertSame(LinkPreviewResult.Failed, fetcher().fetch(server.url("/disconnect").toString()))
    }

  @Test
  fun cancellationCancelsActiveMetadataAndImageCalls() {
    withServer { server ->
      coroutineScope {
        server.enqueue(
          MockResponse()
            // Cancel before OkHttp produces a Response.
            .setHeader("Content-Type", "text/html")
            .setHeadersDelay(30, TimeUnit.SECONDS)
            .setBody("<title>Never delivered</title>"),
        )

        val metadataFetch = async { fetcher(timeoutMillis = 60_000).fetch(server.url("/slow-page").toString()) }
        assertTrue(withContext(Dispatchers.IO) { server.takeRequest(1, TimeUnit.SECONDS) } != null)
        delay(100)

        withTimeout(1_000) {
          metadataFetch.cancelAndJoin()
        }
      }
    }

    withServer { server ->
      coroutineScope {
        server.enqueue(
          MockResponse()
            // Cancel while OkHttp is reading the response body.
            .setHeader("Content-Type", "image/png")
            .setBodyDelay(30, TimeUnit.SECONDS)
            .setBody(Buffer().write(pngBytes(width = 10, height = 10))),
        )

        val imageFetch = async { imageFetcher(timeoutMillis = 60_000).fetch(server.url("/slow-image.png").toString()) }
        assertTrue(withContext(Dispatchers.IO) { server.takeRequest(1, TimeUnit.SECONDS) } != null)
        delay(100)

        withTimeout(1_000) {
          imageFetch.cancelAndJoin()
        }
      }
    }
  }

  @Test
  fun allowsHttpToHttpsRedirectAndRejectsFileRedirect() {
    withServer { server ->
      server.enqueue(redirect("https://secure.example/target"))
      val client =
        baseClient()
          .addInterceptor { chain ->
            val request = chain.request()
            if (!request.url.isHttps) {
              chain.proceed(request)
            } else {
              Response
                .Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body("<title>Secure target</title>".toResponseBody("text/html".toMediaType()))
                .build()
            }
          }.build()

      val result =
        LinkPreviewFetcher(client, hostPolicy = permissiveHostPolicy)
          .fetch(server.url("/start").toString()) as LinkPreviewResult.Loaded

      assertEquals("Secure target", result.metadata.title)
      assertEquals(1, server.requestCount)
    }

    withServer { server ->
      server.enqueue(redirect("file:///tmp/private"))
      assertSame(LinkPreviewResult.Failed, fetcher().fetch(server.url("/start").toString()))
      assertEquals(1, server.requestCount)
    }
  }

  @Test
  fun cacheHitAvoidsSecondFetchIncludingFailures() =
    withServer { server ->
      server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<title>Cached</title>"))
      server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{}"))
      val store = LinkPreviewStore(fetcher = fetcher()::fetch)
      val loadedUrl = server.url("/loaded").toString()
      val failedUrl = server.url("/failed").toString()

      assertTrue(store.get(loadedUrl) is LinkPreviewResult.Loaded)
      assertTrue(store.get(loadedUrl) is LinkPreviewResult.Loaded)
      assertEquals(1, server.requestCount)

      assertSame(LinkPreviewResult.Failed, store.get(failedUrl))
      assertSame(LinkPreviewResult.Failed, store.get(failedUrl))
      assertEquals(2, server.requestCount)
    }

  @Test
  fun imageFetchStartsOnlyWhenStoreIsRequestedAndCacheHitAvoidsSecondRequest() =
    withServer { server ->
      server.enqueue(imageResponse(pngBytes(width = 120, height = 80)))
      val store = SafeRemoteImageStore(fetcher = imageFetcher()::fetch)
      val imageUrl = server.url("/card.png").toString()

      assertEquals(0, server.requestCount)
      assertTrue(store.get(imageUrl) is RemoteImageResult.Raster)
      assertTrue(store.get(imageUrl) is RemoteImageResult.Raster)
      assertEquals(1, server.requestCount)
      assertEquals("image/*", server.takeRequest().getHeader("Accept"))
    }

  @Test
  fun imageCacheEvictsLeastRecentlyUsedBitmapByAllocatedBytes() =
    runBlocking {
      val first = Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888)
      val second = Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888)
      val fetchCounts = mutableMapOf<String, Int>()
      val store =
        SafeRemoteImageStore(
          fetcher = { url ->
            fetchCounts[url] = fetchCounts.getOrDefault(url, 0) + 1
            RemoteImageResult.Raster(if (url == "first") first else second)
          },
          maxBytes = first.allocationByteCount,
        )

      try {
        assertTrue(store.get("first") is RemoteImageResult.Raster)
        assertTrue(store.get("second") is RemoteImageResult.Raster)
        assertTrue(store.get("first") is RemoteImageResult.Raster)

        assertEquals(2, fetchCounts["first"])
        assertEquals(1, fetchCounts["second"])
      } finally {
        first.recycle()
        second.recycle()
      }
    }

  @Test
  fun imageCacheBoundsNegativeResults() =
    runBlocking {
      val fetchCounts = mutableMapOf<String, Int>()
      val store =
        SafeRemoteImageStore(
          fetcher = { url ->
            fetchCounts[url] = fetchCounts.getOrDefault(url, 0) + 1
            RemoteImageResult.Failed
          },
          maxBytes = 2,
        )

      assertSame(RemoteImageResult.Failed, store.get("first"))
      assertSame(RemoteImageResult.Failed, store.get("second"))
      assertSame(RemoteImageResult.Failed, store.get("third"))
      assertSame(RemoteImageResult.Failed, store.get("first"))

      assertEquals(2, fetchCounts["first"])
      assertEquals(1, fetchCounts["second"])
      assertEquals(1, fetchCounts["third"])
    }

  @Test
  fun imageCacheBoundsTinyLoadedResultsByEntryCount() =
    runBlocking {
      val tiny = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
      val maxEntries = 32
      val fetchCounts = mutableMapOf<String, Int>()
      val store =
        SafeRemoteImageStore(
          fetcher = { url ->
            fetchCounts[url] = fetchCounts.getOrDefault(url, 0) + 1
            RemoteImageResult.Raster(tiny)
          },
          maxBytes = tiny.allocationByteCount * maxEntries * 2,
        )

      try {
        repeat(maxEntries + 1) { index ->
          assertTrue(store.get("image-$index") is RemoteImageResult.Raster)
        }
        assertTrue(store.get("image-0") is RemoteImageResult.Raster)

        assertEquals(2, fetchCounts["image-0"])
      } finally {
        tiny.recycle()
      }
    }

  @Test
  fun imageContentTypeAllowlistAndBodyCapAreEnforced() =
    withServer { server ->
      server.enqueue(MockResponse().setHeader("Content-Type", "image/gif").setBody("GIF89a"))
      server.enqueue(MockResponse().setHeader("Content-Type", "image/svg+xml").setBody("<svg/>"))
      server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody("GIF89a"))
      server.enqueue(
        MockResponse()
          .setHeader("Content-Type", "image/png")
          .setBody(Buffer().write(ByteArray(REMOTE_IMAGE_BODY_MAX_BYTES + 1))),
      )

      assertSame(RemoteImageResult.Failed, imageFetcher().fetch(server.url("/animated.gif").toString()))
      assertTrue(imageFetcher().fetch(server.url("/vector.svg").toString()) is RemoteImageResult.Svg)
      assertSame(RemoteImageResult.Failed, imageFetcher().fetch(server.url("/spoofed.png").toString()))
      assertSame(RemoteImageResult.Failed, imageFetcher().fetch(server.url("/oversized.png").toString()))
      assertEquals(4, server.requestCount)
    }

  @Test
  fun privateLiteralImageUrlFailsWithoutNetworkCall() =
    withServer { server ->
      server.enqueue(imageResponse(pngBytes(width = 10, height = 10)))

      assertSame(RemoteImageResult.Failed, realPolicyImageFetcher().fetch(server.url("/private.png").toString()))
      assertEquals(0, server.requestCount)
    }

  @Test
  fun imageRedirectsFollowThreeHopsAndRejectUnsafeOrFourthHop() {
    withServer { server ->
      repeat(3) { index -> server.enqueue(redirect("/image-hop${index + 1}")) }
      server.enqueue(imageResponse(pngBytes(width = 12, height = 8)))

      assertTrue(imageFetcher().fetch(server.url("/image-start").toString()) is RemoteImageResult.Raster)
      assertEquals(4, server.requestCount)
    }

    withServer { server ->
      repeat(4) { index -> server.enqueue(redirect("/image-hop${index + 1}")) }
      server.enqueue(imageResponse(pngBytes(width = 12, height = 8)))

      assertSame(RemoteImageResult.Failed, imageFetcher().fetch(server.url("/image-start").toString()))
      assertEquals(4, server.requestCount)
    }

    withServer { server ->
      server.enqueue(redirect("file:///tmp/private.png"))

      assertSame(RemoteImageResult.Failed, imageFetcher().fetch(server.url("/image-start").toString()))
      assertEquals(1, server.requestCount)
    }
  }

  @Test
  fun imageDecodeDownsamplesLargeSource() {
    val decoded = decodeRemoteImageBitmap(pngBytes(width = 2_400, height = 1_200))

    assertTrue(decoded != null)
    assertTrue(checkNotNull(decoded).width <= REMOTE_IMAGE_MAX_DIMENSION)
    assertTrue(decoded.height <= REMOTE_IMAGE_MAX_DIMENSION)
  }

  @Test
  fun corruptImageIsNegativeCachedWithoutRefetch() =
    withServer { server ->
      server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("not an image"))
      val store = SafeRemoteImageStore(fetcher = imageFetcher()::fetch)
      val imageUrl = server.url("/corrupt.webp").toString()

      assertSame(RemoteImageResult.Failed, store.get(imageUrl))
      assertSame(RemoteImageResult.Failed, store.get(imageUrl))
      assertEquals(1, server.requestCount)
    }

  private fun fetcher(timeoutMillis: Long = 6_000): LinkPreviewFetcher = LinkPreviewFetcher(baseClient().build(), timeoutMillis, permissiveHostPolicy)

  private fun realPolicyFetcher(): LinkPreviewFetcher = LinkPreviewFetcher(baseClient().build())

  private fun imageFetcher(timeoutMillis: Long = 6_000): SafeRemoteImageFetcher = SafeRemoteImageFetcher(SafeWebFetcher(baseClient().build(), timeoutMillis, permissiveHostPolicy))

  private fun realPolicyImageFetcher(): SafeRemoteImageFetcher = SafeRemoteImageFetcher(SafeWebFetcher(baseClient().build()))

  private fun baseClient(): OkHttpClient.Builder =
    OkHttpClient
      .Builder()
      .followRedirects(false)
      .followSslRedirects(false)

  private fun redirect(location: String): MockResponse =
    MockResponse()
      .setResponseCode(302)
      .setHeader("Location", location)

  private fun imageResponse(bytes: ByteArray): MockResponse =
    MockResponse()
      .setHeader("Content-Type", "image/png")
      .setBody(Buffer().write(bytes))

  private fun pngBytes(
    width: Int,
    height: Int,
  ): ByteArray {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    return try {
      bitmap.eraseColor(Color.rgb(24, 96, 192))
      ByteArrayOutputStream().use { output ->
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
      }
    } finally {
      bitmap.recycle()
    }
  }

  private fun withServer(block: suspend (MockWebServer) -> Unit) {
    MockWebServer().use { server ->
      server.start()
      runBlocking { block(server) }
    }
  }

  companion object {
    private val permissiveHostPolicy: (okhttp3.HttpUrl) -> Boolean = { true }
  }
}
