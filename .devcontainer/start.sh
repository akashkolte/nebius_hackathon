#!/usr/bin/env bash
# Starts Dispatch in a Codespace (or any dev container). Safe to run again: it exits if Dispatch is already up.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-4378}"

if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "Dispatch is already running on port $PORT. Open the Ports tab to get its link."
  exit 0
fi

if [ -z "${NEBIUS_API_KEY:-}" ]; then
  if [ -t 0 ]; then
    read -rsp "Paste your Nebius Token Factory API key (input hidden): " NEBIUS_API_KEY; echo
    export NEBIUS_API_KEY
  else
    echo "No NEBIUS_API_KEY found. Open a terminal and run:"
    echo "  export NEBIUS_API_KEY=your-key && bash .devcontainer/start.sh"
    exit 0
  fi
fi

if [ -z "${DISPATCH_PASSWORD:-}" ]; then
  DISPATCH_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")"
  export DISPATCH_PASSWORD
  echo "--------------------------------------------------------------"
  echo " Dispatch password (sign in with this): $DISPATCH_PASSWORD"
  echo "--------------------------------------------------------------"
fi

exec npm start
