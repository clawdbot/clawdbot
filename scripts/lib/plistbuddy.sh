#!/usr/bin/env bash

plist_escape_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

plist_set_string_required() {
  local plist="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(plist_escape_string "$value")"
  /usr/libexec/PlistBuddy -c "Set :$key \"$escaped\"" "$plist"
}

plist_set_or_add_string() {
  local plist="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(plist_escape_string "$value")"
  /usr/libexec/PlistBuddy -c "Set :$key \"$escaped\"" "$plist" ||
    /usr/libexec/PlistBuddy -c "Add :$key string \"$escaped\"" "$plist"
}

plist_set_or_add_bool() {
  local plist="$1"
  local key="$2"
  local value="$3"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist" ||
    /usr/libexec/PlistBuddy -c "Add :$key bool $value" "$plist"
}

plist_print_required() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist"
}
