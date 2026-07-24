#!/usr/bin/env python3

from __future__ import annotations

import json
import pathlib
import re
import sys

EXPECTED_LABEL = "Gemini Enterprise Agent Platform (Vertex AI)"
OLD_LABEL = "Google Vertex AI"
OLD_DOC_HEADING = "Google Vertex and Gemini CLI"
PROVIDER_ID = 'google-vertex'
DOUBLE_QUOTE = chr(34)

REPO_ROOT = pathlib.Path(__file__).resolve().parent


def read_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding='utf-8')


def fail(failures: list[str], relative_path: str, message: str) -> None:
    failures.append(f"{relative_path}: {message}")


def require_contains(
    failures: list[str], relative_path: str, text: str, needle: str, message: str
) -> None:
    if needle not in text:
        fail(failures, relative_path, f"missing {message}: {needle!r}")


def require_not_contains(
    failures: list[str], relative_path: str, text: str, needle: str, message: str
) -> None:
    if needle in text:
        fail(failures, relative_path, f"found stale {message}: {needle!r}")


def require_regex_value(
    failures: list[str],
    relative_path: str,
    text: str,
    pattern: str,
    expected_value: str,
    field_name: str,
) -> None:
    match = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL)
    if not match:
        fail(failures, relative_path, f"could not locate {field_name}")
        return
    actual_value = match.group(1)
    if actual_value != expected_value:
        fail(
            failures,
            relative_path,
            (
                f'expected {field_name} to be {expected_value!r}, '
                f'found {actual_value!r}'
            ),
        )


def check_provider_display_names(failures: list[str]) -> None:
    relative_path = 'src/agents/sessions/provider-display-names.ts'
    text = read_text(relative_path)
    provider_display_pattern = (
        rf'{DOUBLE_QUOTE}google-vertex{DOUBLE_QUOTE}:\s*'
        rf'{DOUBLE_QUOTE}([^{DOUBLE_QUOTE}]+){DOUBLE_QUOTE}'
    )
    require_regex_value(
        failures,
        relative_path,
        text,
        provider_display_pattern,
        EXPECTED_LABEL,
        'built-in provider display name for google-vertex',
    )
    require_not_contains(
        failures,
        relative_path,
        text,
        OLD_LABEL,
        'provider display label',
    )


def check_provider_contract(failures: list[str]) -> None:
    relative_path = 'extensions/google/provider-contract-api.ts'
    text = read_text(relative_path)
    block_match = re.search(
        (
            r'export function createGoogleVertexProvider\(\): ProviderPlugin '\
            r'\{\s*return \{(?P<body>.*?)\n\s*\};\s*\}'
        ),
        text,
        flags=re.DOTALL,
    )
    if not block_match:
        fail(
            failures,
            relative_path,
            'could not locate createGoogleVertexProvider()',
        )
        return

    block = block_match.group('body')
    require_contains(
        failures,
        relative_path,
        block,
        f'id: "{PROVIDER_ID}"',
        "stable provider id",
    )
    require_regex_value(
        failures,
        relative_path,
        block,
        r'label:\s*"([^"]+)"',
        EXPECTED_LABEL,
        'provider contract label for google-vertex',
    )
    require_not_contains(
        failures,
        relative_path,
        block,
        OLD_LABEL,
        'provider contract label',
    )


def check_setup_registration(failures: list[str]) -> None:
    relative_path = 'extensions/google/setup-api.ts'
    text = read_text(relative_path)
    require_contains(
        failures,
        relative_path,
        text,
        'createGoogleVertexProvider',
        'Google Vertex provider factory import',
    )
    require_contains(
        failures,
        relative_path,
        text,
        'api.registerProvider(createGoogleVertexProvider());',
        'Google Vertex provider registration',
    )


def check_docs(failures: list[str]) -> None:
    relative_path = 'docs/concepts/model-providers.md'
    text = read_text(relative_path)
    require_contains(
        failures,
        relative_path,
        text,
        EXPECTED_LABEL,
        'new provider label in docs',
    )
    require_not_contains(
        failures,
        relative_path,
        text,
        OLD_DOC_HEADING,
        'docs heading',
    )


def check_plugin_manifest(failures: list[str]) -> None:
    relative_path = 'extensions/google/openclaw.plugin.json'
    text = read_text(relative_path)
    data = json.loads(text)
    providers = data.get('providers', [])
    if PROVIDER_ID not in providers:
        fail(
            failures,
            relative_path,
            f'provider id {PROVIDER_ID!r} is missing from plugin manifest',
        )


def check_runtime_internal_id(failures: list[str]) -> None:
    relative_path = 'packages/ai/src/providers/google-vertex.ts'
    text = read_text(relative_path)
    stream_function_literal = (
        f'StreamFunction<{DOUBLE_QUOTE}google-vertex{DOUBLE_QUOTE}'
    )
    output_literal = (
        'createGoogleAssistantOutput('
        f'model, {DOUBLE_QUOTE}google-vertex{DOUBLE_QUOTE})'
    )
    require_contains(
        failures,
        relative_path,
        text,
        stream_function_literal,
        "stream function provider id",
    )
    require_contains(
        failures,
        relative_path,
        text,
        output_literal,
        "assistant output provider id",
    )
    require_contains(
        failures,
        relative_path,
        text,
        f'"{EXPECTED_LABEL} requires a project ID.',
        "updated project-id error label",
    )
    require_contains(
        failures,
        relative_path,
        text,
        f'"{EXPECTED_LABEL} requires a location.',
        "updated location error label",
    )
    require_not_contains(failures, relative_path, text, OLD_LABEL, "runtime label")
    require_not_contains(
        failures,
        relative_path,
        text,
        "Vertex AI requires",
        "runtime error wording",
    )


def check_model_registry_fallback(failures: list[str]) -> None:
    relative_path = 'src/agents/sessions/model-registry.ts'
    text = read_text(relative_path)
    require_contains(
        failures,
        relative_path,
        text,
        "BUILT_IN_PROVIDER_DISPLAY_NAMES[provider]",
        "built-in provider display-name fallback",
    )


def main() -> int:
    failures: list[str] = []

    check_provider_display_names(failures)
    check_provider_contract(failures)
    check_setup_registration(failures)
    check_docs(failures)
    check_plugin_manifest(failures)
    check_runtime_internal_id(failures)
    check_model_registry_fallback(failures)

    if failures:
        print('google-vertex label regression check failed:')
        for failure in failures:
            print(f'- {failure}')
        return 1

    message = (
        f'PASS: {PROVIDER_ID} keeps its internal id and all checked label '
        f'surfaces use {EXPECTED_LABEL!r}.'
    )
    print(message)
    return 0


if __name__ == '__main__':
    sys.exit(main())
