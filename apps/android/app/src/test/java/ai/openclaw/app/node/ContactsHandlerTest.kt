package ai.openclaw.app.node

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactsHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleContactsSearch_requiresReadPermission() {
    val handler = ContactsHandler.forTesting(appContext(), FakeContactsDataSource(canRead = false))

    val result = handler.handleContactsSearch(null)

    assertFalse(result.ok)
    assertEquals("CONTACTS_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handleContactsAdd_rejectsEmptyContact() {
    val handler =
      ContactsHandler.forTesting(
        appContext(),
        FakeContactsDataSource(canRead = true, canWrite = true),
      )

    val result = handler.handleContactsAdd("""{"givenName":" ","emails":[]}""")

    assertFalse(result.ok)
    assertEquals("CONTACTS_INVALID", result.error?.code)
  }

  @Test
  fun handleContactsSearch_returnsContacts() {
    val contact =
      ContactRecord(
        identifier = "1",
        displayName = "Ada Lovelace",
        givenName = "Ada",
        familyName = "Lovelace",
        organizationName = "Analytical Engine",
        phoneNumbers = listOf("+12025550123"),
        emails = listOf("ada@example.com"),
      )
    val handler =
      ContactsHandler.forTesting(
        appContext(),
        FakeContactsDataSource(canRead = true, searchResults = listOf(contact)),
      )

    val result = handler.handleContactsSearch("""{"query":"ada","limit":1}""")

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val contacts = payload.getValue("contacts").jsonArray
    assertEquals(1, contacts.size)
    assertEquals(
      "Ada Lovelace",
      contacts
        .first()
        .jsonObject
        .getValue("displayName")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleContactsSearch_preservesExplicitJsonNullQuery() {
    val source = FakeContactsDataSource(canRead = true)
    val handler = ContactsHandler.forTesting(appContext(), source)

    val result = handler.handleContactsSearch("""{"query":null}""")

    assertTrue(result.ok)
    assertEquals("null", source.searchedRequest?.query)
    assertEquals(25, source.searchedRequest?.limit)
  }

  @Test
  fun handleContactsAdd_returnsAddedContact() {
    val added =
      ContactRecord(
        identifier = "2",
        displayName = "Grace Hopper",
        givenName = "Grace",
        familyName = "Hopper",
        organizationName = "US Navy",
        phoneNumbers = listOf(),
        emails = listOf("grace@example.com"),
      )
    val source = FakeContactsDataSource(canRead = true, canWrite = true, addResult = added)
    val handler = ContactsHandler.forTesting(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """{"givenName":"Grace","familyName":"Hopper","emails":["grace@example.com"]}""",
      )

    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(result.payloadJson ?: error("missing payload")).jsonObject
    val contact = payload.getValue("contact").jsonObject
    assertEquals("Grace Hopper", contact.getValue("displayName").jsonPrimitive.content)
    assertEquals(1, source.addCalls)
  }

  @Test
  fun handleContactsAdd_omitsExplicitJsonNullFields() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler.forTesting(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """
        {"givenName":"Grace","familyName":null,"organizationName":null,"displayName":null,
         "phoneNumbers":[null,"+15550100"],"emails":[null]}
        """.trimIndent(),
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals("Grace", request.givenName)
    assertNull(request.familyName)
    assertNull(request.organizationName)
    assertNull(request.displayName)
    assertEquals(listOf("+15550100"), request.phoneNumbers)
    assertTrue(request.emails.isEmpty())
  }

  @Test
  fun handleContactsAdd_rejectsOnlyExplicitJsonNullFields() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler.forTesting(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """{"givenName":null,"familyName":null,"organizationName":null,"phoneNumbers":[null],"emails":[null]}""",
      )

    assertFalse(result.ok)
    assertEquals("CONTACTS_INVALID", result.error?.code)
    assertEquals(0, source.addCalls)
    assertNull(source.addedRequest)
  }

  @Test
  fun handleContactsAdd_preservesLiteralNullStrings() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler.forTesting(appContext(), source)

    val result = handler.handleContactsAdd("""{"givenName":"null","phoneNumbers":["null"]}""")

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals("null", request.givenName)
    assertEquals(listOf("null"), request.phoneNumbers)
  }
}

private class FakeContactsDataSource(
  private val canRead: Boolean,
  private val canWrite: Boolean = false,
  private val searchResults: List<ContactRecord> = emptyList(),
  private val addResult: ContactRecord =
    ContactRecord(
      identifier = "0",
      displayName = "Default",
      givenName = "",
      familyName = "",
      organizationName = "",
      phoneNumbers = emptyList(),
      emails = emptyList(),
    ),
) : ContactsDataSource {
  var addCalls: Int = 0
    private set

  var searchedRequest: ContactsSearchRequest? = null
    private set

  var addedRequest: ContactsAddRequest? = null
    private set

  override fun hasReadPermission(context: Context): Boolean = canRead

  override fun hasWritePermission(context: Context): Boolean = canWrite

  override fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord> {
    searchedRequest = request
    return searchResults
  }

  override fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord {
    addCalls += 1
    addedRequest = request
    return addResult
  }
}
