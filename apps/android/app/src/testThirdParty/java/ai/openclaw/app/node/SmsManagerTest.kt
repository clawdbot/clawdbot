package ai.openclaw.app.node

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsManagerTest {
  private val json = SmsManager.JsonConfig

  private fun smsMessage(
    id: Long,
    date: Long,
    status: Int = 0,
    body: String? = "msg-$id",
    transportType: String? = null,
  ): SmsManager.SmsMessage =
    SmsManager.SmsMessage(
      id = id,
      threadId = 1L,
      address = "+15551234567",
      person = null,
      date = date,
      dateSent = date,
      read = true,
      type = 1,
      body = body,
      status = status,
      transportType = transportType,
    )

  @Test
  fun parseParamsRejectsEmptyPayload() {
    val result = SmsManager.parseParams("", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: paramsJSON required", error.error)
  }

  @Test
  fun parseParamsRejectsInvalidJson() {
    val result = SmsManager.parseParams("not-json", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsNonObjectJson() {
    val result = SmsManager.parseParams("[]", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsMissingTo() {
    val result = SmsManager.parseParams("{\"message\":\"Hi\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'to' phone number required", error.error)
    assertEquals("Hi", error.message)
  }

  @Test
  fun parseParamsRejectsMissingMessage() {
    val result = SmsManager.parseParams("{\"to\":\"+1234\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'message' text required", error.error)
    assertEquals("+1234", error.to)
  }

  @Test
  fun parseParamsTrimsToField() {
    val result = SmsManager.parseParams("{\"to\":\"  +1555  \",\"message\":\"Hello\"}", json)
    assertTrue(result is SmsManager.ParseResult.Ok)
    val ok = result as SmsManager.ParseResult.Ok
    assertEquals("+1555", ok.params.to)
    assertEquals("Hello", ok.params.message)
  }

  @Test
  fun parseQueryParamsDefaultsWhenPayloadEmpty() {
    val result = SmsManager.parseQueryParams(null, json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(25, ok.params.limit)
    assertEquals(0, ok.params.offset)
    assertEquals(null, ok.params.startTime)
    assertEquals(null, ok.params.endTime)
  }

  @Test
  fun parseQueryParamsRejectsInvalidJson() {
    val result = SmsManager.parseQueryParams("not-json", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsRejectsInvertedTimeRange() {
    val result = SmsManager.parseQueryParams("{\"startTime\":200,\"endTime\":100}", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: startTime must be less than or equal to endTime", error.error)
  }

  @Test
  fun parseQueryParamsClampsLimitAndOffset() {
    val result = SmsManager.parseQueryParams("{\"limit\":999,\"offset\":-5}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(200, ok.params.limit)
    assertEquals(0, ok.params.offset)
  }

  @Test
  fun parseQueryParamsParsesAllSupportedFields() {
    val result =
      SmsManager.parseQueryParams(
        """
        {
          "startTime": 100,
          "endTime": 200,
          "contactName": " Leah ",
          "phoneNumber": " +1555 ",
          "keyword": " ping ",
          "type": 1,
          "isRead": true,
          "limit": 10,
          "offset": 2
        }
        """.trimIndent(),
        json,
      )
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(100L, ok.params.startTime)
    assertEquals(200L, ok.params.endTime)
    assertEquals("Leah", ok.params.contactName)
    assertEquals("+1555", ok.params.phoneNumber)
    assertEquals("ping", ok.params.keyword)
    assertEquals(1, ok.params.type)
    assertEquals(true, ok.params.isRead)
    assertEquals(10, ok.params.limit)
    assertEquals(2, ok.params.offset)
  }

  @Test
  fun buildPayloadJsonEscapesFields() {
    val payload =
      SmsManager.buildPayloadJson(
        json = json,
        ok = false,
        to = "+1\"23",
        error = "SMS_SEND_FAILED: \"nope\"",
      )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("false", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals("+1\"23", parsed["to"]?.jsonPrimitive?.content)
    assertEquals("SMS_SEND_FAILED: \"nope\"", parsed["error"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildQueryPayloadJsonIncludesCountAndMessages() {
    val payload =
      SmsManager.buildQueryPayloadJson(
        json = json,
        ok = true,
        messages =
          listOf(
            SmsManager.SmsMessage(
              id = 1L,
              threadId = 2L,
              address = "+1555",
              person = null,
              date = 123L,
              dateSent = 124L,
              read = true,
              type = 1,
              body = "hello",
              status = 0,
            ),
          ),
      )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("true", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals(1, parsed["count"]?.jsonPrimitive?.content?.toInt())
    val messages = parsed["messages"]?.jsonArray
    assertEquals(1, messages?.size)
    assertEquals(
      "hello",
      messages
        ?.get(0)
        ?.jsonObject
        ?.get("body")
        ?.jsonPrimitive
        ?.content,
    )
  }

  @Test
  fun buildQueryPayloadJsonIncludesErrorOnFailure() {
    val payload =
      SmsManager.buildQueryPayloadJson(
        json = json,
        ok = false,
        messages = emptyList(),
        error = "SMS_QUERY_FAILED: nope",
      )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("false", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals(0, parsed["count"]?.jsonPrimitive?.content?.toInt())
    assertEquals("SMS_QUERY_FAILED: nope", parsed["error"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildQueryPayloadJsonIncludesMmsMetadataWhenProvided() {
    val payload =
      SmsManager.buildQueryPayloadJson(
        json = json,
        ok = true,
        messages = listOf(smsMessage(id = 1L, date = 1000L)),
        queryMetadata =
          SmsManager.QueryMetadata(
            mmsRequested = true,
            mmsEligible = true,
            mmsAttempted = true,
            mmsIncluded = false,
          ),
      )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("true", parsed["mmsRequested"]?.jsonPrimitive?.content)
    assertEquals("true", parsed["mmsEligible"]?.jsonPrimitive?.content)
    assertEquals("true", parsed["mmsAttempted"]?.jsonPrimitive?.content)
    assertEquals("false", parsed["mmsIncluded"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildSendPlanUsesMultipartWhenMultipleParts() {
    val plan = SmsManager.buildSendPlan("hello") { listOf("a", "b") }
    assertTrue(plan.useMultipart)
    assertEquals(listOf("a", "b"), plan.parts)
  }

  @Test
  fun buildSendPlanFallsBackToSinglePartWhenDividerEmpty() {
    val plan = SmsManager.buildSendPlan("hello") { emptyList() }
    assertFalse(plan.useMultipart)
    assertEquals(listOf("hello"), plan.parts)
  }

  @Test
  fun parseQueryParamsAcceptsEmptyPayload() {
    val result = SmsManager.parseQueryParams(null, json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(25, ok.params.limit)
    assertEquals(0, ok.params.offset)
  }

  @Test
  fun parseQueryParamsRejectsNonObjectJson() {
    val result = SmsManager.parseQueryParams("[]", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsParsesLimitAndOffset() {
    val result = SmsManager.parseQueryParams("{\"limit\":10,\"offset\":5}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(10, ok.params.limit)
    assertEquals(5, ok.params.offset)
  }

  @Test
  fun parseQueryParamsClampsLimitRange() {
    val result = SmsManager.parseQueryParams("{\"limit\":300}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(200, ok.params.limit)
  }

  @Test
  fun parseQueryParamsParsesPhoneNumber() {
    val result = SmsManager.parseQueryParams("{\"phoneNumber\":\"+1234567890\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("+1234567890", ok.params.phoneNumber)
  }

  @Test
  fun parseQueryParamsParsesContactName() {
    val result = SmsManager.parseQueryParams("{\"contactName\":\"lixuankai\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("lixuankai", ok.params.contactName)
  }

  @Test
  fun parseQueryParamsParsesKeyword() {
    val result = SmsManager.parseQueryParams("{\"keyword\":\"test\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("test", ok.params.keyword)
  }

  @Test
  fun parseQueryParamsParsesTimeRange() {
    val result = SmsManager.parseQueryParams("{\"startTime\":1000,\"endTime\":2000}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1000L, ok.params.startTime)
    assertEquals(2000L, ok.params.endTime)
  }

  @Test
  fun parseQueryParamsParsesType() {
    val result = SmsManager.parseQueryParams("{\"type\":1}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1, ok.params.type)
  }

  @Test
  fun parseQueryParamsParsesReadStatus() {
    val result = SmsManager.parseQueryParams("{\"isRead\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(true, ok.params.isRead)
  }

  @Test
  fun parseQueryParamsIncludeMmsDefaultsFalse() {
    val result = SmsManager.parseQueryParams("{}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertFalse(ok.params.includeMms)
  }

  @Test
  fun parseQueryParamsParsesIncludeMmsTrue() {
    val result = SmsManager.parseQueryParams("{\"includeMms\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertTrue(ok.params.includeMms)
  }

  @Test
  fun parseQueryParamsParsesConversationReviewTrue() {
    val result = SmsManager.parseQueryParams("{\"conversationReview\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertTrue(ok.params.conversationReview)
  }

  @Test
  fun toByPhoneLookupNumberStripsFormattingToDigits() {
    assertEquals("12107588120", SmsManager.toByPhoneLookupNumber("+1 (210) 758-8120"))
  }

  @Test
  fun normalizePhoneNumberOrNullReturnsNullForFormattingOnlyInput() {
    assertNull(SmsManager.normalizePhoneNumberOrNull("() -   "))
  }

  @Test
  fun normalizePhoneNumberOrNullReturnsNullForPlusOnlyInput() {
    assertNull(SmsManager.normalizePhoneNumberOrNull(" + "))
  }

  @Test
  fun normalizePhoneNumberOrNullKeepsUsableNormalizedNumber() {
    assertEquals("+15551234567", SmsManager.normalizePhoneNumberOrNull(" +1 (555) 123-4567 "))
  }

  @Test
  fun sanitizeContactPhoneNumberOrNullDropsFormattingOnlyInput() {
    assertNull(SmsManager.sanitizeContactPhoneNumberOrNull(" () -   "))
  }

  @Test
  fun sanitizeContactPhoneNumberOrNullDropsPlusOnlyInput() {
    assertNull(SmsManager.sanitizeContactPhoneNumberOrNull(" + "))
  }

  @Test
  fun sanitizeContactPhoneNumberOrNullKeepsUsableNormalizedNumber() {
    assertEquals("+15551234567", SmsManager.sanitizeContactPhoneNumberOrNull(" +1 (555) 123-4567 "))
  }

  @Test
  fun sanitizeContactPhoneNumberOrNullDropsPercentWildcardInput() {
    assertNull(SmsManager.sanitizeContactPhoneNumberOrNull("1%2"))
  }

  @Test
  fun sanitizeContactPhoneNumberOrNullDropsUnderscoreWildcardInput() {
    assertNull(SmsManager.sanitizeContactPhoneNumberOrNull("1_2"))
  }

  @Test
  fun shouldPromptForContactNameSearchPermissionTrueForContactNameOnlyWithoutContactsAccess() {
    assertTrue(
      SmsManager.shouldPromptForContactNameSearchPermission(
        contactName = "Alice",
        phoneNumber = null,
        hasReadContactsPermission = false,
      ),
    )
  }

  @Test
  fun shouldPromptForContactNameSearchPermissionFalseWhenExplicitPhoneFallbackExists() {
    assertFalse(
      SmsManager.shouldPromptForContactNameSearchPermission(
        contactName = "Alice",
        phoneNumber = "+15551234567",
        hasReadContactsPermission = false,
      ),
    )
  }

  @Test
  fun shouldPromptForContactNameSearchPermissionFalseWhenContactsAlreadyGranted() {
    assertFalse(
      SmsManager.shouldPromptForContactNameSearchPermission(
        contactName = "Alice",
        phoneNumber = null,
        hasReadContactsPermission = true,
      ),
    )
  }

  @Test
  fun escapeSqlLikeLiteralEscapesPercentUnderscoreAndBackslash() {
    assertEquals("\\%a\\_b\\\\c", SmsManager.escapeSqlLikeLiteral("%a_b\\c"))
  }

  @Test
  fun escapeSqlLikeLiteralLeavesOrdinaryTextUnchanged() {
    assertEquals("Leah", SmsManager.escapeSqlLikeLiteral("Leah"))
  }

  @Test
  fun buildContactNameLikeSelectionUsesSingleBackslashEscapeLiteral() {
    assertEquals(
      "display_name LIKE ? ESCAPE '\\'",
      SmsManager.buildContactNameLikeSelection(),
    )
  }

  @Test
  fun buildContactNameLikeArgEscapesWildcardsAndBackslash() {
    assertEquals("%\\%a\\_b\\\\c%", SmsManager.buildContactNameLikeArg("%a_b\\c"))
  }

  @Test
  fun buildKeywordLikeSelectionUsesSingleBackslashEscapeLiteral() {
    assertEquals(
      "body LIKE ? ESCAPE '\\'",
      SmsManager.buildKeywordLikeSelection(),
    )
  }

  @Test
  fun buildKeywordLikeArgEscapesWildcardsAndBackslash() {
    assertEquals("%\\%a\\_b\\\\c%", SmsManager.buildKeywordLikeArg("%a_b\\c"))
  }

  @Test
  fun buildMixedByPhoneProjectionMatchesExpectedStatusAwareShape() {
    assertArrayEquals(
      arrayOf(
        "_id",
        "thread_id",
        "transport_type",
        "address",
        "date",
        "date_sent",
        "read",
        "type",
        "body",
        "status",
      ),
      SmsManager.buildMixedByPhoneProjection(),
    )
  }

  @Test
  fun compareByPhoneCandidateOrderUsesDateThenIdDescending() {
    val newer = smsMessage(id = 1L, date = 2000L)
    val older = smsMessage(id = 2L, date = 1000L)
    val sameDateHigherId = smsMessage(id = 9L, date = 1500L)
    val sameDateLowerId = smsMessage(id = 3L, date = 1500L)

    assertTrue(SmsManager.compareByPhoneCandidateOrder(newer, older) < 0)
    assertTrue(SmsManager.compareByPhoneCandidateOrder(sameDateHigherId, sameDateLowerId) < 0)
    assertTrue(SmsManager.compareByPhoneCandidateOrder(sameDateLowerId, sameDateHigherId) > 0)
  }

  @Test
  fun upsertTopDateCandidatesKeepsDescendingOrderAndBounds() {
    val candidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    val max = 2

    SmsManager.upsertTopDateCandidates(candidates, "sms:1", smsMessage(id = 1L, date = 1700L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:2", smsMessage(id = 2L, date = 2000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:3", smsMessage(id = 3L, date = 1500L), max)

    assertEquals(listOf(2L, 1L), candidates.map { it.second.id })
    assertEquals(listOf(2000L, 1700L), candidates.map { it.second.date })
  }

  @Test
  fun upsertTopDateCandidatesSupportsDefaultMixedPathBoundedWindow() {
    val params = SmsManager.QueryParams(limit = 3, offset = 2, includeMms = true, phoneNumber = "+15551234567")
    val candidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    val max = params.offset + params.limit

    SmsManager.upsertTopDateCandidates(candidates, "sms:1", smsMessage(id = 1L, date = 1000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:2", smsMessage(id = 2L, date = 2000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:3", smsMessage(id = 3L, date = 3000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:4", smsMessage(id = 4L, date = 4000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:5", smsMessage(id = 5L, date = 5000L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:6", smsMessage(id = 6L, date = 6000L), max)

    assertEquals(5, candidates.size)
    assertEquals(listOf(6L, 5L, 4L, 3L, 2L), candidates.map { it.second.id })
    assertEquals(listOf(4000L, 3000L, 2000L), SmsManager.pageByPhoneCandidates(candidates.map { it.second }, params).map { it.date })
  }

  @Test
  fun upsertTopDateCandidatesDedupesBySourceAwareIdentityAndKeepsBestOrdering() {
    val candidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    val max = 5

    SmsManager.upsertTopDateCandidates(candidates, "sms:1987", smsMessage(id = 1987L, date = 1773950752506L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:1986", smsMessage(id = 1986L, date = 1773899354039L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:1985", smsMessage(id = 1985L, date = 1773872989602L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:1981", smsMessage(id = 1981L, date = 1773790733566L), max)
    SmsManager.upsertTopDateCandidates(candidates, "sms:1976", smsMessage(id = 1976L, date = 1773784153770L), max)

    // same source-aware identity should replace, not duplicate
    SmsManager.upsertTopDateCandidates(candidates, "sms:1986", smsMessage(id = 1986L, date = 1773899354039L), max)
    // different source-aware identity with same raw id must be preserved
    SmsManager.upsertTopDateCandidates(candidates, "mms:1986", smsMessage(id = 1986L, date = 1773899354038L), max)

    assertEquals(5, candidates.size)
    assertEquals(2, candidates.count { it.second.id == 1986L })
    assertEquals(listOf("sms:1987", "sms:1986", "mms:1986", "sms:1985", "sms:1981"), candidates.map { it.first })
  }

  @Test
  fun materializeByPhoneCandidateDedupesBySourceAwareIdentity() {
    val candidates = linkedMapOf<String, SmsManager.SmsMessage>()

    SmsManager.materializeByPhoneCandidate(candidates, "sms:1", smsMessage(id = 1L, date = 1000L))
    SmsManager.materializeByPhoneCandidate(candidates, "sms:1", smsMessage(id = 1L, date = 2000L))
    SmsManager.materializeByPhoneCandidate(candidates, "mms:1", smsMessage(id = 1L, date = 1500L))

    assertEquals(2, candidates.size)
    assertEquals(2000L, candidates["sms:1"]?.date)
    assertEquals(1500L, candidates["mms:1"]?.date)
  }

  @Test
  fun collectMixedByPhoneCandidateUsesBoundedCollectorWhenReviewModeDisabled() {
    val topCandidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    val materializedCandidates = linkedMapOf<String, SmsManager.SmsMessage>()

    SmsManager.collectMixedByPhoneCandidate(
      topCandidates = topCandidates,
      materializedCandidates = materializedCandidates,
      identityKey = "sms:1",
      message = smsMessage(id = 1L, date = 1000L),
      maxCandidates = 1,
      reviewMode = false,
    )
    SmsManager.collectMixedByPhoneCandidate(
      topCandidates = topCandidates,
      materializedCandidates = materializedCandidates,
      identityKey = "mms:2",
      message = smsMessage(id = 2L, date = 2000L, transportType = "mms"),
      maxCandidates = 1,
      reviewMode = false,
    )

    assertEquals(listOf(2L), topCandidates.map { it.second.id })
    assertTrue(materializedCandidates.isEmpty())
  }

  @Test
  fun collectMixedByPhoneCandidateMaterializesFullSetWhenReviewModeEnabled() {
    val topCandidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    val materializedCandidates = linkedMapOf<String, SmsManager.SmsMessage>()

    SmsManager.collectMixedByPhoneCandidate(
      topCandidates = topCandidates,
      materializedCandidates = materializedCandidates,
      identityKey = "sms:1",
      message = smsMessage(id = 1L, date = 1000L),
      maxCandidates = 1,
      reviewMode = true,
    )
    SmsManager.collectMixedByPhoneCandidate(
      topCandidates = topCandidates,
      materializedCandidates = materializedCandidates,
      identityKey = "mms:2",
      message = smsMessage(id = 2L, date = 2000L, transportType = "mms"),
      maxCandidates = 1,
      reviewMode = true,
    )

    assertTrue(topCandidates.isEmpty())
    assertEquals(listOf(1L, 2L), materializedCandidates.values.map { it.id })
  }

  @Test
  fun pageMixedByPhoneCandidatesLetsReviewModeSurfaceOlderRowsBeyondBoundedDefaultWindow() {
    val params =
      SmsManager.QueryParams(
        limit = 2,
        offset = 2,
        includeMms = true,
        phoneNumber = "+15551234567",
        conversationReview = true,
      )
    val topCandidates =
      listOf(
        "sms:9" to smsMessage(id = 9L, date = 9000L),
        "sms:8" to smsMessage(id = 8L, date = 8000L),
        "sms:7" to smsMessage(id = 7L, date = 7000L),
      )
    val materializedCandidates =
      linkedMapOf(
        "sms:9" to smsMessage(id = 9L, date = 9000L),
        "sms:8" to smsMessage(id = 8L, date = 8000L),
        "sms:7" to smsMessage(id = 7L, date = 7000L),
        "mms:6" to smsMessage(id = 6L, date = 6000L, transportType = "mms"),
      )

    val defaultPage =
      SmsManager.pageMixedByPhoneCandidates(
        topCandidates = topCandidates,
        materializedCandidates = materializedCandidates,
        params = params.copy(conversationReview = false),
        reviewMode = false,
      )
    val reviewPage =
      SmsManager.pageMixedByPhoneCandidates(
        topCandidates = topCandidates,
        materializedCandidates = materializedCandidates,
        params = params,
        reviewMode = true,
      )

    assertEquals(listOf(7L), defaultPage.map { it.id })
    assertEquals(listOf(7L, 6L), reviewPage.map { it.id })
    assertEquals(4, materializedCandidates.size)
  }

  @Test
  fun pageByPhoneCandidatesHonorsDeepOffsetAfterStableSort() {
    val params = SmsManager.QueryParams(limit = 5, offset = 5, includeMms = true)
    val candidates =
      listOf(
        smsMessage(id = 1399L, date = 1741112335720L),
        smsMessage(id = 1976L, date = 1773784153770L),
        smsMessage(id = 1981L, date = 1773790733566L),
        smsMessage(id = 1985L, date = 1773872989602L),
        smsMessage(id = 1986L, date = 1773899354039L),
        smsMessage(id = 1987L, date = 1773950752506L),
      )

    assertEquals(listOf(1399L), SmsManager.pageByPhoneCandidates(candidates, params).map { it.id })
    assertTrue(SmsManager.pageByPhoneCandidates(candidates, params.copy(offset = 10)).isEmpty())
  }

  @Test
  fun upsertTopDateCandidatesNoOpWhenMaxIsZero() {
    val candidates = mutableListOf<Pair<String, SmsManager.SmsMessage>>()
    SmsManager.upsertTopDateCandidates(candidates, "sms:1", smsMessage(id = 1L, date = 2000L), 0)
    assertTrue(candidates.isEmpty())
  }

  @Test
  fun buildMixedRowIdentityUsesTransportTypeAndRowId() {
    assertEquals("sms:7", SmsManager.buildMixedRowIdentity(7L, "sms"))
    assertEquals("mms:7", SmsManager.buildMixedRowIdentity(7L, "mms"))
    assertEquals("unknown:7", SmsManager.buildMixedRowIdentity(7L, null))
    assertEquals("unknown:7", SmsManager.buildMixedRowIdentity(7L, ""))
  }

  @Test
  fun normalizeProviderDateMillisConvertsSecondsToMillis() {
    assertEquals(1773944910000L, SmsManager.normalizeProviderDateMillis(1773944910L))
  }

  @Test
  fun normalizeProviderDateMillisKeepsMillisUnchanged() {
    assertEquals(1773944910123L, SmsManager.normalizeProviderDateMillis(1773944910123L))
  }

  @Test
  fun normalizeProviderDateMillisKeepsHistoricMillisUnchanged() {
    assertEquals(946684800000L, SmsManager.normalizeProviderDateMillis(946684800000L))
  }

  @Test
  fun resolveMixedByPhoneRowStatusPreservesRealSmsStatus() {
    assertEquals(64, SmsManager.resolveMixedByPhoneRowStatus("sms", 64))
    assertEquals(32, SmsManager.resolveMixedByPhoneRowStatus(null, 32))
  }

  @Test
  fun resolveMixedByPhoneRowStatusKeepsMmsOnSentinelValue() {
    assertEquals(-1, SmsManager.resolveMixedByPhoneRowStatus("mms", 64))
    assertEquals(-1, SmsManager.resolveMixedByPhoneRowStatus("MMS", null))
  }

  @Test
  fun resolveMixedByPhoneRowStatusFallsBackToZeroWhenSmsStatusMissing() {
    assertEquals(0, SmsManager.resolveMixedByPhoneRowStatus("sms", null))
  }

  @Test
  fun resolveMixedByPhoneRowAddressPreservesProviderAddressWhenPresent() {
    assertEquals(
      "+12107588120",
      SmsManager.resolveMixedByPhoneRowAddress("+12107588120", "12107588120"),
    )
  }

  @Test
  fun resolveMixedByPhoneRowAddressFallsBackToLookupNumberWhenProviderAddressMissing() {
    assertEquals(
      "12107588120",
      SmsManager.resolveMixedByPhoneRowAddress(null, "12107588120"),
    )
  }

  @Test
  fun resolveMixedByPhoneRowAddressCanPreserveLookupNumberWhenProviderAlreadyReturnsIt() {
    assertEquals(
      "12107588120",
      SmsManager.resolveMixedByPhoneRowAddress("12107588120", "12107588120"),
    )
  }

  @Test
  fun resolveMixedByPhoneRowAddressPreservesNonMatchingProviderAddress() {
    assertEquals(
      "+13105550123",
      SmsManager.resolveMixedByPhoneRowAddress("+13105550123", "12107588120"),
    )
  }

  @Test
  fun resolveMixedByPhoneRowAddressPrefersResolvedMmsParticipantAddress() {
    assertEquals(
      "+13105550123",
      SmsManager.resolveMixedByPhoneRowAddress("insert-address-token", "12107588120", "+13105550123"),
    )
  }

  @Test
  fun selectPreferredMmsAddressPrefersType137AddressThatDoesNotMatchLookup() {
    assertEquals(
      "+13105550123",
      SmsManager.selectPreferredMmsAddress(
        listOf(
          "+12107588120" to 151,
          "+13105550123" to 137,
          "+12107588120" to 130,
        ),
        "12107588120",
      ),
    )
  }

  @Test
  fun selectPreferredMmsAddressFallsBackToFirstNormalizedAddressWhenOnlyLookupMatchesExist() {
    assertEquals(
      "+12107588120",
      SmsManager.selectPreferredMmsAddress(
        listOf(
          "insert-address-token" to 137,
          "+12107588120" to 151,
        ),
        "12107588120",
      ),
    )
  }

  @Test
  fun isExplicitPhoneInputInvalidTrueWhenCallerSuppliesOnlyFormatting() {
    val normalized = SmsManager.normalizePhoneNumberOrNull(" + ")
    assertTrue(SmsManager.isExplicitPhoneInputInvalid(" + ", normalized))
  }

  @Test
  fun hasSqlLikeWildcardDetectsPercentAndUnderscore() {
    assertTrue(SmsManager.hasSqlLikeWildcard("+1555%1234"))
    assertTrue(SmsManager.hasSqlLikeWildcard("+1555_1234"))
    assertFalse(SmsManager.hasSqlLikeWildcard("+15551234"))
  }

  @Test
  fun isExplicitPhoneInputInvalidRejectsLikeWildcardPhoneFilter() {
    assertTrue(SmsManager.isExplicitPhoneInputInvalid("+1555%1234", "+1555%1234"))
    assertTrue(SmsManager.isExplicitPhoneInputInvalid("+1555_1234", "+1555_1234"))
  }

  @Test
  fun isExplicitPhoneInputInvalidFalseWhenPhoneWasOmitted() {
    assertFalse(SmsManager.isExplicitPhoneInputInvalid(null, null))
    assertFalse(SmsManager.isExplicitPhoneInputInvalid("   ", null))
  }

  @Test
  fun mapMmsMsgBoxToSearchTypeCoversSearchRelevantMmsBoxes() {
    assertEquals(1, SmsManager.mapMmsMsgBoxToSearchType(1))
    assertEquals(2, SmsManager.mapMmsMsgBoxToSearchType(2))
    assertEquals(3, SmsManager.mapMmsMsgBoxToSearchType(3))
    assertEquals(4, SmsManager.mapMmsMsgBoxToSearchType(4))
    assertEquals(5, SmsManager.mapMmsMsgBoxToSearchType(5))
    assertEquals(6, SmsManager.mapMmsMsgBoxToSearchType(6))
  }

  @Test
  fun mapMmsMsgBoxToSearchTypeLeavesUnsupportedBoxesUnmapped() {
    assertNull(SmsManager.mapMmsMsgBoxToSearchType(0))
    assertNull(SmsManager.mapMmsMsgBoxToSearchType(99))
    assertNull(SmsManager.mapMmsMsgBoxToSearchType(null))
  }

  @Test
  fun shouldUseConversationReviewByPhoneModeOnlyForMixedByPhoneReviewPulls() {
    val active =
      SmsManager.QueryParams(
        limit = 5,
        offset = 0,
        isRead = null,
        contactName = null,
        phoneNumber = "+12107588120",
        keyword = null,
        startTime = null,
        endTime = null,
        includeMms = true,
        conversationReview = true,
      )
    val disabledByMode = active.copy(conversationReview = false)
    val disabledByMms = active.copy(includeMms = false)
    val disabledByPhone = active.copy(phoneNumber = null)

    assertTrue(SmsManager.shouldUseConversationReviewByPhoneMode(active))
    assertFalse(SmsManager.shouldUseConversationReviewByPhoneMode(disabledByMode))
    assertFalse(SmsManager.shouldUseConversationReviewByPhoneMode(disabledByMms))
    assertFalse(SmsManager.shouldUseConversationReviewByPhoneMode(disabledByPhone))
  }

  @Test
  fun effectiveSearchParamsRaisesConversationReviewLimitFloor() {
    val params =
      SmsManager.QueryParams(
        limit = 5,
        offset = 0,
        isRead = null,
        contactName = null,
        phoneNumber = "+12107588120",
        keyword = null,
        startTime = null,
        endTime = null,
        includeMms = true,
        conversationReview = true,
      )

    assertEquals(25, SmsManager.effectiveSearchParams(params).limit)
    assertEquals(40, SmsManager.effectiveSearchParams(params.copy(limit = 40)).limit)
    assertEquals(5, SmsManager.effectiveSearchParams(params.copy(conversationReview = false)).limit)

    val singleResolvedContact = params.copy(phoneNumber = null, contactName = "Leah")
    assertEquals(25, SmsManager.effectiveSearchParams(singleResolvedContact, listOf("15551234567")).limit)
    assertEquals(5, SmsManager.effectiveSearchParams(singleResolvedContact, listOf("15551234567", "15557654321")).limit)
    assertEquals(
      SmsManager.effectiveSearchParams(params).limit,
      SmsManager.effectiveSearchParams(singleResolvedContact, listOf("15551234567")).limit,
    )
  }

  @Test
  fun resolveSearchParamsCarriesSingleResolvedContactIntoReviewMode() {
    val params =
      SmsManager.QueryParams(
        limit = 5,
        offset = 0,
        isRead = null,
        contactName = "Leah",
        phoneNumber = null,
        keyword = null,
        startTime = null,
        endTime = null,
        includeMms = true,
        conversationReview = true,
      )

    val beforeResolution = SmsManager.resolveSearchParams(params, normalizedPhoneNumber = null)
    val singleResolved =
      SmsManager.resolveSearchParams(
        params,
        normalizedPhoneNumber = null,
        resolvedPhoneNumbers = listOf("15551234567"),
      )
    val multiResolved =
      SmsManager.resolveSearchParams(
        params,
        normalizedPhoneNumber = null,
        resolvedPhoneNumbers = listOf("15551234567", "15557654321"),
      )
    val explicit =
      SmsManager.resolveSearchParams(
        params.copy(contactName = null, phoneNumber = "+12107588120"),
        normalizedPhoneNumber = "12107588120",
      )
    val nonReview =
      SmsManager.resolveSearchParams(
        params.copy(conversationReview = false),
        normalizedPhoneNumber = null,
        resolvedPhoneNumbers = listOf("15551234567"),
      )

    assertEquals(5, beforeResolution.limit)
    assertEquals(25, singleResolved.limit)
    assertEquals("15551234567", singleResolved.phoneNumber)
    assertTrue(SmsManager.shouldUseConversationReviewByPhoneMode(singleResolved))
    assertEquals(5, multiResolved.limit)
    assertNull(multiResolved.phoneNumber)
    assertFalse(SmsManager.shouldUseConversationReviewByPhoneMode(multiResolved))
    assertEquals(25, explicit.limit)
    assertEquals("12107588120", explicit.phoneNumber)
    assertEquals(5, nonReview.limit)
    assertEquals("15551234567", nonReview.phoneNumber)
    assertFalse(SmsManager.shouldUseConversationReviewByPhoneMode(nonReview))
  }

  @Test
  fun canonicalizeMixedPathPhoneFiltersDedupesEquivalentExplicitAndContactNumbers() {
    assertEquals(
      listOf("15551234567"),
      SmsManager.canonicalizeMixedPathPhoneFilters(listOf("+15551234567", "15551234567")),
    )
  }

  @Test
  fun canonicalizeMixedPathPhoneFiltersDropsBlankByPhoneValues() {
    assertEquals(
      listOf("15551234567"),
      SmsManager.canonicalizeMixedPathPhoneFilters(listOf("+15551234567", "+", "   ")),
    )
  }

  @Test
  fun buildQueryMetadataUsesCanonicalizedSingleMixedFilterAsEligible() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567")
    val canonical = SmsManager.canonicalizeMixedPathPhoneFilters(listOf("+15551234567", "15551234567"))

    val metadata = SmsManager.buildQueryMetadata(params, canonical, emptyList())

    assertTrue(metadata.mmsEligible)
    assertTrue(metadata.mmsAttempted)
  }

  @Test
  fun requestedMixedByPhoneCandidateWindowAddsOffsetAndLimitSafely() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567", limit = 200, offset = 300)
    assertEquals(500L, SmsManager.requestedMixedByPhoneCandidateWindow(params))
  }

  @Test
  fun exceedsMixedByPhoneCandidateWindowFalseAtSupportedBoundary() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567", limit = 200, offset = 300)
    assertFalse(SmsManager.exceedsMixedByPhoneCandidateWindow(params, listOf("+15551234567")))
  }

  @Test
  fun exceedsMixedByPhoneCandidateWindowTrueWhenSingleNumberMixedWindowTooLarge() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567", limit = 200, offset = 301)
    assertTrue(SmsManager.exceedsMixedByPhoneCandidateWindow(params, listOf("+15551234567")))
  }

  @Test
  fun exceedsMixedByPhoneCandidateWindowFalseForSmsOnlyQueries() {
    val params = SmsManager.QueryParams(includeMms = false, phoneNumber = "+15551234567", limit = 200, offset = 50000)
    assertFalse(SmsManager.exceedsMixedByPhoneCandidateWindow(params, listOf("+15551234567")))
  }

  @Test
  fun exceedsMixedByPhoneCandidateWindowFalseWhenMultiplePhoneNumbersDisableMixedByPhonePath() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = null, limit = 200, offset = 50000)
    assertFalse(SmsManager.exceedsMixedByPhoneCandidateWindow(params, listOf("+15551234567", "+15557654321")))
  }

  @Test
  fun mixedByPhoneWindowErrorMentionsSupportedWindow() {
    assertEquals(
      "INVALID_REQUEST: includeMms offset+limit exceeds supported window (500)",
      SmsManager.mixedByPhoneWindowError(),
    )
  }

  @Test
  fun buildQueryMetadataMarksIneligibleWhenIncludeMmsNotRequested() {
    val params = SmsManager.QueryParams(includeMms = false)

    val metadata = SmsManager.buildQueryMetadata(params, emptyList(), emptyList())

    assertFalse(metadata.mmsRequested)
    assertFalse(metadata.mmsEligible)
    assertFalse(metadata.mmsAttempted)
    assertFalse(metadata.mmsIncluded)
  }

  @Test
  fun buildQueryMetadataMarksEligibleAttemptedButNotIncludedForSingleNumberFallback() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567")
    val messages = listOf(smsMessage(id = 1L, date = 1000L))

    val metadata = SmsManager.buildQueryMetadata(params, listOf("+15551234567"), messages)

    assertTrue(metadata.mmsRequested)
    assertTrue(metadata.mmsEligible)
    assertTrue(metadata.mmsAttempted)
    assertFalse(metadata.mmsIncluded)
  }

  @Test
  fun isMmsTransportRowTrueOnlyForMmsTransport() {
    assertTrue(SmsManager.isMmsTransportRow(smsMessage(id = 1L, date = 1000L, transportType = "mms")))
    assertFalse(SmsManager.isMmsTransportRow(smsMessage(id = 2L, date = 1000L, transportType = "sms")))
    assertFalse(SmsManager.isMmsTransportRow(smsMessage(id = 3L, date = 1000L, transportType = null)))
  }

  @Test
  fun shouldHydrateMmsByPhoneRowTrueOnlyForMmsTransportWithBlankBodyOrZeroType() {
    assertTrue(SmsManager.shouldHydrateMmsByPhoneRow("mms", null, 1))
    assertTrue(SmsManager.shouldHydrateMmsByPhoneRow("mms", "", 1))
    assertTrue(SmsManager.shouldHydrateMmsByPhoneRow("mms", "body", 0))
    assertFalse(SmsManager.shouldHydrateMmsByPhoneRow("sms", null, 0))
    assertFalse(SmsManager.shouldHydrateMmsByPhoneRow(null, null, 0))
    assertFalse(SmsManager.shouldHydrateMmsByPhoneRow("mms", "body", 1))
  }

  @Test
  fun buildQueryMetadataDoesNotTreatSmsStatusSentinelAsMmsInclusion() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567")
    val smsLikeMessage = smsMessage(id = 7L, date = 1000L, status = -1, transportType = "sms")

    val metadata = SmsManager.buildQueryMetadata(params, listOf("15551234567"), listOf(smsLikeMessage))

    assertTrue(metadata.mmsRequested)
    assertTrue(metadata.mmsEligible)
    assertTrue(metadata.mmsAttempted)
    assertFalse(metadata.mmsIncluded)
  }

  @Test
  fun buildQueryMetadataMarksIncludedWhenMixedQueryYieldsMmsTransportRow() {
    val params = SmsManager.QueryParams(includeMms = true, phoneNumber = "+15551234567")
    val mmsTransportMessage = smsMessage(id = 7L, date = 1000L, status = 0, body = null, transportType = "mms")

    val metadata = SmsManager.buildQueryMetadata(params, listOf("15551234567"), listOf(mmsTransportMessage))

    assertTrue(metadata.mmsRequested)
    assertTrue(metadata.mmsEligible)
    assertTrue(metadata.mmsAttempted)
    assertTrue(metadata.mmsIncluded)
  }
}
