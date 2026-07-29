"""Structured API errors for PropertyManager."""

from __future__ import annotations

from flask import jsonify


def error_response(
    code: str,
    message: str,
    *,
    field: str | None = None,
    details: list[dict[str, str]] | None = None,
    status: int = 400,
    extra: dict | None = None,
):
    body: dict = {
        "code": code,
        "message": message,
    }
    if field is not None:
        body["field"] = field
    if details:
        body["details"] = details
    if extra:
        body.update(extra)
    return jsonify(body), status


def validation_error(message: str, *, field: str | None = None, details: list | None = None):
    return error_response("VALIDATION_ERROR", message, field=field, details=details, status=400)
