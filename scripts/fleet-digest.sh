#!/usr/bin/env bash
# fleet-digest shim — finds its .mjs next to the real script even when
# invoked through a symlink on PATH (~/.local/bin/fleet-digest).
set -euo pipefail
# Resolve this script's directory portably on macOS, BSD, and Linux
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
exec node --no-warnings "$DIR/fleet-digest.mjs" "$@"
