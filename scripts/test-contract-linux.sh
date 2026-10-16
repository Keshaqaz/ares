#!/usr/bin/env bash
set -euo pipefail
# Download/checksum the pinned binary before entering this network namespace.
# Ubuntu Actions has passwordless sudo. Keep the tests as the ORIGINAL non-root
# user: root in a user namespace can bypass chmod(0400), invalidating save-failure QA.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'linux_x64_required' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'nonroot_test_user_required' >&2; exit 1; }
command -v bwrap >/dev/null || { echo 'bubblewrap_required' >&2; exit 1; }
node_path="$(command -v node)"
binary_path="${AUTO_RESET_CODEX_BIN:-$PWD/.runtime/codex}"
[[ "$binary_path" == /* && -x "$binary_path" ]] || { echo 'absolute_pinned_binary_required' >&2; exit 1; }
sudo -n unshare --net -- sh -c '
  ip link set lo up
  exec runuser -u "$1" -- env PATH="$2" AUTO_RESET_CODEX_BIN="$3" "$4" testing/contract.mjs
' sh "$(id -un)" "$PATH" "$binary_path" "$node_path"
