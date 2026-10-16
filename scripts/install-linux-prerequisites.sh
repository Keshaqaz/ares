#!/usr/bin/env bash
set -euo pipefail
# Ubuntu's signed AppArmor package supplies the restricted bubblewrap profile.
# Keep system-wide user namespace restrictions and Codex configWarning guard enabled.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'linux_x64_required' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'nonroot_runner_required' >&2; exit 1; }
sudo apt-get update -qq
sudo apt-get install --no-install-recommends --yes bubblewrap apparmor apparmor-profiles apparmor-utils
if [[ -f /sys/module/apparmor/parameters/enabled ]] && [[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]]; then
  if [[ ! -f /etc/apparmor.d/bwrap-userns-restrict ]]; then
    [[ -f /usr/share/apparmor/extra-profiles/bwrap-userns-restrict ]] || { echo 'bubblewrap_apparmor_profile_required' >&2; exit 1; }
    sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
  fi
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
fi
# This is the pinned App Server's startup probe, under the actual runner user.
timeout --signal=TERM --kill-after=5s 10s bwrap --unshare-user --unshare-net --ro-bind / / /bin/true
