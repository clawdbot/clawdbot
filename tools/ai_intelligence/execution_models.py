"""Typed models for provider-neutral AI execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping
from uuid import uuid4


class ExecutionModelError(ValueError):
    """Raised when execution model data is invalid."""


class AttemptStatus(str, Enum):
    """Outcome of one provider execution attempt."""

    SUCCESS = "success"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    INVALID_RESPONSE = "invalid-response"
    PROVIDER_ERROR = "provider-error"


class ExecutionStatus(str, Enum):
    """Overall outcome after processing the routing chain."""

    SUCCESS = "success"
    FAILED = "failed"


@dataclass(frozen=True)
class ProviderRequest:
    """One request sent to one model through one provider."""

    model_id: str
    prompt: str
    request_id: str = field(
        default_factory=lambda: str(uuid4())
    )
    system_prompt: str | None = None
    timeout_seconds: float = 60.0
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.model_id.strip():
            raise ExecutionModelError(
                "model_id must not be blank"
            )

        if not self.prompt.strip():
            raise ExecutionModelError(
                "prompt must not be blank"
            )

        if not self.request_id.strip():
            raise ExecutionModelError(
                "request_id must not be blank"
            )

        if self.timeout_seconds <= 0:
            raise ExecutionModelError(
                "timeout_seconds must be greater than zero"
            )


@dataclass(frozen=True)
class ProviderResponse:
    """Successful normalized response from an AI provider."""

    provider_name: str
    model_id: str
    content: str
    duration_ms: int
    raw_response: Mapping[str, Any] = field(
        default_factory=dict
    )

    def __post_init__(self) -> None:
        if not self.provider_name.strip():
            raise ExecutionModelError(
                "provider_name must not be blank"
            )

        if not self.model_id.strip():
            raise ExecutionModelError(
                "model_id must not be blank"
            )

        if not self.content.strip():
            raise ExecutionModelError(
                "content must not be blank"
            )

        if self.duration_ms < 0:
            raise ExecutionModelError(
                "duration_ms must not be negative"
            )


@dataclass(frozen=True)
class ExecutionAttempt:
    """Recorded outcome of one candidate-model attempt."""

    provider_name: str
    model_id: str
    status: AttemptStatus
    started_at: datetime
    finished_at: datetime
    duration_ms: int
    content: str | None = None
    error_type: str | None = None
    error_message: str | None = None

    def __post_init__(self) -> None:
        if not self.provider_name.strip():
            raise ExecutionModelError(
                "provider_name must not be blank"
            )

        if not self.model_id.strip():
            raise ExecutionModelError(
                "model_id must not be blank"
            )

        if self.finished_at < self.started_at:
            raise ExecutionModelError(
                "finished_at must not precede started_at"
            )

        if self.duration_ms < 0:
            raise ExecutionModelError(
                "duration_ms must not be negative"
            )

        if self.status is AttemptStatus.SUCCESS:
            if self.content is None or not self.content.strip():
                raise ExecutionModelError(
                    "successful attempt requires content"
                )

            if self.error_message is not None:
                raise ExecutionModelError(
                    "successful attempt cannot contain an error"
                )
        elif self.content is not None:
            raise ExecutionModelError(
                "failed attempt cannot contain content"
            )

    @classmethod
    def success(
        cls,
        response: ProviderResponse,
        *,
        started_at: datetime,
        finished_at: datetime,
    ) -> "ExecutionAttempt":
        return cls(
            provider_name=response.provider_name,
            model_id=response.model_id,
            status=AttemptStatus.SUCCESS,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=response.duration_ms,
            content=response.content,
        )

    @classmethod
    def failure(
        cls,
        *,
        provider_name: str,
        model_id: str,
        status: AttemptStatus,
        started_at: datetime,
        finished_at: datetime,
        duration_ms: int,
        error: Exception,
    ) -> "ExecutionAttempt":
        if status is AttemptStatus.SUCCESS:
            raise ExecutionModelError(
                "failure attempt cannot use success status"
            )

        return cls(
            provider_name=provider_name,
            model_id=model_id,
            status=status,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            error_type=type(error).__name__,
            error_message=str(error),
        )


@dataclass(frozen=True)
class ExecutionResult:
    """Final result after processing the model fallback chain."""

    request_id: str
    component_id: str
    status: ExecutionStatus
    attempts: tuple[ExecutionAttempt, ...]
    content: str | None = None
    selected_model_id: str | None = None

    def __post_init__(self) -> None:
        if not self.request_id.strip():
            raise ExecutionModelError(
                "request_id must not be blank"
            )

        if not self.component_id.strip():
            raise ExecutionModelError(
                "component_id must not be blank"
            )

        if not self.attempts:
            raise ExecutionModelError(
                "execution result requires at least one attempt"
            )

        successful_attempts = tuple(
            attempt
            for attempt in self.attempts
            if attempt.status is AttemptStatus.SUCCESS
        )

        if self.status is ExecutionStatus.SUCCESS:
            if len(successful_attempts) != 1:
                raise ExecutionModelError(
                    "successful result requires exactly one "
                    "successful attempt"
                )

            successful_attempt = successful_attempts[0]

            if self.content != successful_attempt.content:
                raise ExecutionModelError(
                    "result content must match successful attempt"
                )

            if self.selected_model_id != successful_attempt.model_id:
                raise ExecutionModelError(
                    "selected model must match successful attempt"
                )
        else:
            if successful_attempts:
                raise ExecutionModelError(
                    "failed result cannot contain a successful attempt"
                )

            if self.content is not None:
                raise ExecutionModelError(
                    "failed result cannot contain content"
                )

            if self.selected_model_id is not None:
                raise ExecutionModelError(
                    "failed result cannot select a model"
                )

    @property
    def succeeded(self) -> bool:
        return self.status is ExecutionStatus.SUCCESS

    @property
    def failed(self) -> bool:
        return self.status is ExecutionStatus.FAILED

    @property
    def attempted_model_ids(self) -> tuple[str, ...]:
        return tuple(
            attempt.model_id for attempt in self.attempts
        )


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""

    return datetime.now(timezone.utc)
