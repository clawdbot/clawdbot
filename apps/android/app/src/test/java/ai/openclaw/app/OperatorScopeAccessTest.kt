package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OperatorScopeAccessTest {
  @Test
  fun operatorAuthorityFollowsGatewayReadWriteAdminHierarchy() {
    assertTrue(operatorScopesAllowRead(listOf("operator.read")))
    assertTrue(operatorScopesAllowRead(listOf("operator.write")))
    assertTrue(operatorScopesAllowRead(listOf("operator.admin")))
    assertFalse(operatorScopesAllowRead(emptyList()))

    assertTrue(operatorScopesAllowWrite(listOf("operator.write")))
    assertTrue(operatorScopesAllowWrite(listOf("operator.admin")))
    assertFalse(operatorScopesAllowWrite(listOf("operator.read")))

    assertTrue(operatorScopesAllowAdmin(listOf("operator.admin")))
    assertFalse(operatorScopesAllowAdmin(listOf("operator.write")))
  }

  @Test
  fun catalogDiscoveryRequiresBothAdvertisementAndReadAuthority() {
    val catalogMethods = setOf("sessions.catalog.list")

    assertTrue(sessionCatalogAvailableFor(catalogMethods, listOf("operator.read")))
    assertTrue(sessionCatalogAvailableFor(catalogMethods, listOf("operator.write")))
    assertTrue(sessionCatalogAvailableFor(catalogMethods, listOf("operator.admin")))
    assertFalse(sessionCatalogAvailableFor(catalogMethods, emptyList()))
    assertFalse(sessionCatalogAvailableFor(emptySet(), listOf("operator.read")))
  }
}
