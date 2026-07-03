#!/bin/zsh
# SYSTEM X2 local supervisor — restarts the fleet whenever the medic exits it.
# (In the cloud, GitHub Actions plays this role; locally, this loop does.)
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
while true; do
  node server.js >> bot-data/server.log 2>&1
  echo "[supervisor] fleet exited $(date) — restarting in 5s" >> bot-data/server.log
  sleep 5
done
