package ai.openclaw.app

import ai.openclaw.app.ui.isWorkspaceDirectoryRequestInFlight
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceFilesTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun tracksDirectoryRequestInFlightAcrossRefreshAndPagination() {
    assertEquals(false, isWorkspaceDirectoryRequestInFlight(loading = false, loadingMore = false))
    assertEquals(true, isWorkspaceDirectoryRequestInFlight(loading = true, loadingMore = false))
    assertEquals(true, isWorkspaceDirectoryRequestInFlight(loading = false, loadingMore = true))
    assertEquals(true, isWorkspaceDirectoryRequestInFlight(loading = true, loadingMore = true))
  }

  @Test
  fun parsesListingEntriesAndPagination() {
    val payload =
      """
      {
        "agentId": "main",
        "workspace": "/tmp/workspace",
        "path": "src",
        "parentPath": "",
        "entries": [
          {"path": "src/util", "name": "util", "kind": "directory", "updatedAtMs": 1700000000000},
          {"path": "src/index.ts", "name": "index.ts", "kind": "file", "size": 42, "updatedAtMs": 1700000000123}
        ],
        "totalEntries": 12,
        "offset": 0
      }
      """.trimIndent()

    val listing = parseWorkspaceListing(json.parseToJsonElement(payload))

    assertEquals("src", listing?.path)
    assertEquals(12, listing?.totalEntries)
    assertEquals(0, listing?.offset)
    assertEquals(2, listing?.entries?.size)
    val directory = listing?.entries?.first()
    assertEquals(true, directory?.isDirectory)
    assertNull(directory?.size)
    val file = listing?.entries?.last()
    assertEquals(false, file?.isDirectory)
    assertEquals(42L, file?.size)
    assertEquals(1_700_000_000_123L, file?.updatedAtMs)
  }

  @Test
  fun parsesTextAndImageFilePayloads() {
    val text =
      parseWorkspaceFile(
        json.parseToJsonElement(
          """{"agentId":"main","workspace":"/w","file":{"path":"notes.md","name":"notes.md","size":8,"updatedAtMs":1,"mimeType":"text/plain","encoding":"utf8","content":"# Notes\n"}}""",
        ),
      )
    assertEquals("notes.md", text?.name)
    assertEquals(false, text?.isBase64)
    assertEquals("# Notes\n", text?.content)

    val image =
      parseWorkspaceFile(
        json.parseToJsonElement(
          """{"agentId":"main","workspace":"/w","file":{"path":"shot.png","name":"shot.png","size":3,"updatedAtMs":1,"mimeType":"image/png","encoding":"base64","content":"AAECAw=="}}""",
        ),
      )
    assertEquals(true, image?.isBase64)
    assertTrue(image?.mimeType?.startsWith("image/") == true)
  }

  @Test
  fun rejectsPayloadsWithoutFileOrPath() {
    assertNull(parseWorkspaceFile(Json.parseToJsonElement("""{"agentId":"main"}""")))
    assertNull(
      parseWorkspaceFile(
        Json.parseToJsonElement("""{"file":{"name":"x","size":1,"mimeType":"text/plain","encoding":"utf8","content":""}}"""),
      ),
    )
  }
}
