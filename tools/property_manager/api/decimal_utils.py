"""Decimal-safe numeric handling for meter values."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


def parse_decimal(value: Any, *, field: str = "value") -> Decimal:
    if value is None or value == "":
        raise ValueError(f"{field} is required")
    try:
        if isinstance(value, Decimal):
            return value
        if isinstance(value, float):
            return Decimal(str(value))
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field} must be a decimal number") from exc


def format_decimal(value: Decimal | None, *, places: int = 3) -> str | None:
    if value is None:
        return None
    quant = Decimal("1").scaleb(-places)
    normalized = value.quantize(quant, rounding=ROUND_HALF_UP)
    text = format(normalized, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def decimal_to_db(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
