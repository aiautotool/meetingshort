#!/usr/bin/env bash
# Build, install and launch a self-contained Release app on a physical iPhone.
# Optional: ./scripts/build-install-ios.sh <device-udid-or-name>
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IOS_TARGET="${1:-${IOS_DEVICE:-${EXPO_DEVICE:-}}}"

command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }
command -v xcrun >/dev/null || { echo "Xcode command-line tools are required." >&2; exit 1; }

discover_single_connected_iphone() {
  local devices_json
  devices_json="$(mktemp)"
  if ! xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1; then
    rm -f "$devices_json"
    return
  fi
  local count
  count="$(jq '[.result.devices[] | select(.hardwareProperties.platform == "iOS" and .hardwareProperties.reality == "physical")] | length' "$devices_json")"
  if [[ "$count" == "1" ]]; then
    jq -r '.result.devices[] | select(.hardwareProperties.platform == "iOS" and .hardwareProperties.reality == "physical") | .hardwareProperties.udid' "$devices_json"
  fi
  rm -f "$devices_json"
}

wait_until_device_is_unlocked() {
  local device="$1"
  local timeout_seconds="${WAIT_FOR_DEVICE_UNLOCK_SECONDS:-180}"
  local started_at="$(date +%s)"
  local lock_json="$(mktemp)"

  while true; do
    if xcrun devicectl device info lockState --device "$device" --json-output "$lock_json" >/dev/null 2>&1 && [[ "$(jq -r 'if .result.passcodeRequired == false then "false" else "true" end' "$lock_json")" == "false" ]]; then
      break
    fi
    if (( $(date +%s) - started_at >= timeout_seconds )); then
      rm -f "$lock_json"
      echo "iPhone vẫn đang khóa sau ${timeout_seconds} giây. Mở khóa, giữ màn hình sáng, rồi chạy lại." >&2
      exit 70
    fi
    echo "Đang chờ iPhone mở khóa… hãy nhập mật mã và giữ màn hình sáng."
    sleep 2
  done
  rm -f "$lock_json"
  xcrun devicectl device info details --device "$device" >/dev/null 2>&1 || {
    echo "Không thể chuẩn bị iPhone. Hãy rút/cắm cáp và xác nhận Trust This Computer." >&2
    exit 70
  }
}

if [[ -z "$IOS_TARGET" ]]; then
  IOS_TARGET="$(discover_single_connected_iphone)"
fi
if [[ -z "$IOS_TARGET" ]]; then
  echo "Không tìm thấy đúng một iPhone vật lý. Kết nối iPhone hoặc truyền UDID vào script." >&2
  exit 70
fi

wait_until_device_is_unlocked "$IOS_TARGET"
echo "Building and installing on $IOS_TARGET"

npm install
npx expo prebuild --platform ios --no-install
exec npx expo run:ios --configuration Release --no-bundler --device "$IOS_TARGET"
