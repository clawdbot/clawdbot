#!/usr/bin/env python3
"""Auth + route-shape tests for PropertyManager mutating category/task/parts routes.

These are in-process Flask tests (no live Gunicorn / postgres required).
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

API_DIR = Path(__file__).resolve().parents[1] / "api"
TEST_API_KEY = "test-mutating-route-key"

# Mutating category / task / parts endpoints that must require credentials.
WRITE_CASES: list[tuple[str, str, dict | list | None]] = [
    ("POST", "/categories", {"name": ""}),
    ("DELETE", "/categories/00000000-0000-0000-0000-000000000001", {}),
    ("POST", "/tasks", {}),
    ("PATCH", "/tasks/00000000-0000-0000-0000-000000000001", {"item": "x"}),
    ("DELETE", "/tasks/00000000-0000-0000-0000-000000000001", None),
    ("PUT", "/tasks/00000000-0000-0000-0000-000000000001/parts", []),
    ("POST", "/tasks/00000000-0000-0000-0000-000000000001/parts", {}),
    ("POST", "/tasks/00000000-0000-0000-0000-000000000001/complete", {}),
]


def _load_app():
    """Import the Flask app with auth enabled and a known API key."""
    env = {
        "PROPERTYMANAGER_AUTH_DISABLED": "0",
        "PROPERTYMANAGER_API_KEY": TEST_API_KEY,
        "PROPERTYMANAGER_DB_VIA_DOCKER": "1",
    }
    with mock.patch.dict(os.environ, env, clear=False):
        # Ensure API modules resolve from tools/property_manager/api.
        if str(API_DIR) not in sys.path:
            sys.path.insert(0, str(API_DIR))
        for name in (
            "auth",
            "db",
            "errors",
            "decimal_utils",
            "meter_schedule",
            "assets_api",
            "mapping_proposals",
            "propertymanager_api",
        ):
            if name in sys.modules:
                del sys.modules[name]
        import auth  # noqa: F401
        import propertymanager_api as api

        # Re-assert constants in case modules were partially cached.
        auth.AUTH_DISABLED = False
        auth.API_KEY = TEST_API_KEY
        return api


class MutatingRouteAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.api = _load_app()
        cls.client = cls.api.app.test_client()

    def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {TEST_API_KEY}",
            "Content-Type": "application/json",
            "X-Operator-Identity": "auth-test",
        }

    def test_unauthenticated_writes_return_401(self) -> None:
        for method, path, body in WRITE_CASES:
            with self.subTest(method=method, path=path):
                response = self.client.open(
                    path,
                    method=method,
                    json=body,
                    headers={"Content-Type": "application/json"},
                )
                self.assertEqual(response.status_code, 401, response.get_json())
                payload = response.get_json()
                self.assertIsInstance(payload, dict)
                self.assertEqual(payload.get("code"), "UNAUTHORIZED")

    def test_unauthenticated_category_post_is_401_not_validation(self) -> None:
        """Acceptance probe: empty name used to return 400; must be 401 first."""
        response = self.client.post(
            "/categories",
            json={"name": ""},
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 401)
        payload = response.get_json()
        self.assertEqual(payload.get("code"), "UNAUTHORIZED")
        self.assertNotIn("name is required", str(payload))

    def test_authenticated_category_empty_name_returns_400(self) -> None:
        response = self.client.post(
            "/categories",
            json={"name": ""},
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "name is required")

    def test_authenticated_task_upsert_non_object_returns_400(self) -> None:
        response = self.client.open(
            "/tasks",
            method="POST",
            data="[]",
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "JSON object body required")

    def test_authenticated_patch_empty_body_returns_400(self) -> None:
        response = self.client.patch(
            "/tasks/00000000-0000-0000-0000-000000000001",
            json={},
            headers=self._auth_headers(),
        )
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "No fields to update")

    def test_authenticated_replace_parts_non_array_returns_400(self) -> None:
        with mock.patch.object(self.api, "fetch_task_or_404", return_value={"id": "t"}):
            response = self.client.put(
                "/tasks/00000000-0000-0000-0000-000000000001/parts",
                json={"not": "a list"},
                headers=self._auth_headers(),
            )
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "JSON array body required")

    def test_authenticated_create_part_non_object_returns_400(self) -> None:
        with mock.patch.object(self.api, "fetch_task_or_404", return_value={"id": "t"}):
            response = self.client.open(
                "/tasks/00000000-0000-0000-0000-000000000001/parts",
                method="POST",
                data="[]",
                headers=self._auth_headers(),
            )
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "JSON object body required")

    def test_authenticated_delete_task_not_found_shape(self) -> None:
        with mock.patch.object(self.api.pm_db, "execute", return_value=0):
            response = self.client.delete(
                "/tasks/00000000-0000-0000-0000-000000000001",
                headers=self._auth_headers(),
            )
        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "Task not found")

    def test_authenticated_delete_category_not_found_shape(self) -> None:
        with mock.patch.object(self.api.pm_db, "execute_one_json", return_value=None):
            response = self.client.delete(
                "/categories/00000000-0000-0000-0000-000000000001",
                json={},
                headers=self._auth_headers(),
            )
        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertEqual(payload.get("error"), "Category not found")

    def test_reads_remain_unauthenticated(self) -> None:
        with mock.patch.object(self.api.pm_db, "execute_json", return_value=[]):
            response = self.client.get("/categories")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [])


class DockerExecInterruptMessageTests(unittest.TestCase):
    def test_signal_kill_maps_to_interrupt_message(self) -> None:
        if str(API_DIR) not in sys.path:
            sys.path.insert(0, str(API_DIR))
        import db as pm_db

        importlib.reload(pm_db)
        fake = mock.Mock(returncode=-15, stderr="", stdout="")
        with self.assertRaises(RuntimeError) as raised:
            pm_db._raise_psql_failure(fake)
        self.assertIn("interrupted", str(raised.exception).lower())
        self.assertIn("reload", str(raised.exception).lower())


if __name__ == "__main__":
    unittest.main()
