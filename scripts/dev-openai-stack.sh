#!/usr/bin/env bash

set -euo pipefail

HELPER_HOST="${HELPER_HOST:-127.0.0.1}"
HELPER_PORT="${HELPER_PORT:-4318}"
ADAPTER_HOST="${ADAPTER_HOST:-127.0.0.1}"
ADAPTER_PORT="${ADAPTER_PORT:-4319}"

HELPER_BASE_URL_INPUT="${HELPER_BASE_URL:-}"
HELPER_BASE_URL="${HELPER_BASE_URL_INPUT:-http://${HELPER_HOST}:${HELPER_PORT}}"

list_listen_pids() {
  local port="$1"
  lsof -n -P -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

show_port_owners() {
  local port="$1"
  lsof -n -P -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null >&2 || true
}

resolve_port_conflict() {
  local name="$1"
  local port="$2"

  while true; do
    local pids
    pids="$(list_listen_pids "${port}")"
    if [[ -z "${pids}" ]]; then
      printf '%s' "${port}"
      return 0
    fi

    echo "[${name}] 端口 ${port} 已被占用。" >&2
    show_port_owners "${port}"
    echo "请选择操作：" >&2
    echo "1) 强制关闭占用该端口的进程" >&2
    echo "2) 换一个新的端口" >&2
    echo "3) 退出" >&2
    read -r -p "输入 1/2/3: " action >&2

    case "${action}" in
      1)
        echo "正在强制关闭进程: ${pids}" >&2
        kill -9 ${pids} >/dev/null 2>&1 || true
        sleep 0.2
        ;;
      2)
        read -r -p "请输入新的端口: " new_port >&2
        if [[ ! "${new_port}" =~ ^[0-9]+$ ]] || ((new_port < 1 || new_port > 65535)); then
          echo "端口无效: ${new_port}" >&2
          continue
        fi
        port="${new_port}"
        ;;
      3)
        echo "已退出。" >&2
        exit 1
        ;;
      *)
        echo "无效输入: ${action}" >&2
        ;;
    esac
  done
}

cleanup() {
  if [[ -n "${ADAPTER_PID:-}" ]]; then
    kill "${ADAPTER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${HELPER_PID:-}" ]]; then
    kill "${HELPER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -t 0 ]]; then
  echo "当前不是交互终端，无法处理端口冲突交互。请在终端直接运行。" >&2
  exit 1
fi

HELPER_PORT="$(resolve_port_conflict "helper" "${HELPER_PORT}")"
ADAPTER_PORT="$(resolve_port_conflict "adapter" "${ADAPTER_PORT}")"

if [[ -z "${HELPER_BASE_URL_INPUT}" ]]; then
  HELPER_BASE_URL="http://${HELPER_HOST}:${HELPER_PORT}"
fi

PORT="${HELPER_PORT}" npm run dev:helper &
HELPER_PID=$!

HELPER_BASE_URL="${HELPER_BASE_URL}" PORT="${ADAPTER_PORT}" npm run dev:openai-adapter &
ADAPTER_PID=$!

wait "${HELPER_PID}" "${ADAPTER_PID}"
