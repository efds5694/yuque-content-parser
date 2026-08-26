#!/usr/bin/env bash
set -euo pipefail

schema_path="${1:?missing schema path}"
prompt="${2:?missing prompt}"

codex_bin="${YUQUE_AI_CODEX_BIN:-}"
if [[ -z "$codex_bin" ]] && command -v codex >/dev/null 2>&1; then
  codex_bin="$(command -v codex)"
fi

if [[ -z "$codex_bin" ]]; then
  for candidate in \
    "$HOME"/.vscode-server/extensions/openai.chatgpt-*/bin/linux-x86_64/codex \
    "$HOME"/.vscode-server-insiders/extensions/openai.chatgpt-*/bin/linux-x86_64/codex \
    "$HOME"/.vscode/extensions/openai.chatgpt-*/bin/linux-x86_64/codex
  do
    if [[ -x "$candidate" ]]; then
      codex_bin="$candidate"
    fi
  done
fi

if [[ -z "$codex_bin" || ! -x "$codex_bin" ]]; then
  echo "找不到 Codex CLI。请先在 WSL 中安装/登录 Codex，或设置 YUQUE_AI_CODEX_BIN。" >&2
  exit 127
fi

exec "$codex_bin" exec \
  --ephemeral \
  --sandbox read-only \
  --skip-git-repo-check \
  --output-schema "$schema_path" \
  "$prompt"
