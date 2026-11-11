#!/bin/sh
set -eu
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
exec node "$(dirname "$0")/server.mjs"
