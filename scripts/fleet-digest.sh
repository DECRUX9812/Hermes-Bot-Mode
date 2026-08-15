#!/usr/bin/env bash
# fleet-digest shim — finds its .mjs next to the real script even when
# invoked through a symlink on PATH (~/.local/bin/fleet-digest).
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec node --no-warnings "$DIR/fleet-digest.mjs" "$@"
