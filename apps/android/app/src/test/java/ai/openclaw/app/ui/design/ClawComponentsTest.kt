package ai.openclaw.app.ui.design

import org.junit.Assert.assertEquals
import org.junit.Test

class ClawComponentsTest {
  @Test
  fun emptySegmentedOptionsProduceNoRows() {
    assertEquals(emptyList<List<String>>(), segmentedControlRows(emptyList()))
  }

  @Test
  fun segmentedOptionsStayOnOneRowByDefault() {
    val options = listOf("One", "Two", "Three", "Four", "Five")

    assertEquals(listOf(options), segmentedControlRows(options))
  }

  @Test
  fun optedInSmallSegmentedOptionSetsStayOnOneRow() {
    val options = listOf("One", "Two", "Three", "Four")

    assertEquals(listOf(options), segmentedControlRows(options, maxOptionsPerRow = 4))
  }

  @Test
  fun fiveSegmentedOptionsSplitIntoBalancedRows() {
    val options = listOf("Pending", "Held", "Applied", "Rejected", "All")

    assertEquals(
      listOf(
        listOf("Pending", "Held", "Applied"),
        listOf("Rejected", "All"),
      ),
      segmentedControlRows(options, maxOptionsPerRow = 4),
    )
  }

  @Test
  fun largerSegmentedOptionSetsKeepRowsBalancedAndBounded() {
    val rows = segmentedControlRows((1..10).map(Int::toString), maxOptionsPerRow = 4)

    assertEquals(listOf(4, 3, 3), rows.map { it.size })
    assertEquals((1..10).map(Int::toString), rows.flatten())
  }
}
