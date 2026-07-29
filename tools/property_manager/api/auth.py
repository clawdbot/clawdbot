"""Authentication seam for PropertyManager API (dev stub + API key)."""

from __future__ import annotations

import os
from functools import wraps
from typing import Callable

from flask import g, request

from errors import error_response

API_KEY = os.environ.get("PROPERTYMANAGER_API_KEY", "").strip()
DEV_OPERATOR_PIN = os.environ.get("PROPERTYMANAGER_OPERATOR_PIN", "dev-pin").strip()
AUTH_DISABLED = os.environ.get("PROPERTYMANAGER_AUTH_DISABLED", "").strip().lower() in {
    "1",
    "true",
    "yes",
}


def auth_required(*, allow_pin: bool = False) -> Callable:
    """Require API key or Bearer token for mutating endpoints."""

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if AUTH_DISABLED:
                g.operator_identity = request.headers.get("X-Operator-Identity", "dev-anonymous")
                g.integration_identity = request.headers.get("X-Integration-Identity")
                return fn(*args, **kwargs)

            identity = _resolve_identity(allow_pin=allow_pin)
            if identity is None:
                return error_response(
                    "UNAUTHORIZED",
                    "Authentication required. Set Authorization: Bearer <api_key> or X-API-Key header.",
                    status=401,
                )
            g.operator_identity = identity.get("operator")
            g.integration_identity = identity.get("integration")
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def _resolve_identity(*, allow_pin: bool) -> dict[str, str | None] | None:
    api_key = request.headers.get("X-API-Key") or ""
    auth_header = request.headers.get("Authorization") or ""
    if auth_header.lower().startswith("bearer "):
        api_key = auth_header[7:].strip()

    if API_KEY and api_key and api_key == API_KEY:
        return {
            "operator": request.headers.get("X-Operator-Identity", "api-key-operator"),
            "integration": request.headers.get("X-Integration-Identity"),
        }

    if allow_pin:
        pin = request.headers.get("X-Operator-PIN") or request.form.get("operator_pin") or ""
        if pin and pin == DEV_OPERATOR_PIN:
            return {
                "operator": request.headers.get("X-Operator-Identity", "qr-operator"),
                "integration": "dashboard-qr",
            }

    return None


def auth_status() -> dict:
    return {
        "auth_required": not AUTH_DISABLED,
        "auth_mode": "disabled" if AUTH_DISABLED else "api_key",
        "pin_auth_supported": bool(DEV_OPERATOR_PIN),
    }
