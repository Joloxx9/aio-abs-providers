#!/bin/sh
set -e

# Fix ownership of the mounted config file so the app user can write to it.
# This runs as root (before USER app takes effect) and is needed because Docker
# volume mounts preserve host ownership, which may differ from the container's
# app user UID.
if [ -f /app/src/config/config.json ]; then
  chown app:app /app/src/config/config.json
fi

# Drop privileges and exec the main process as the app user.
# gosu is used instead of `su` because it correctly forwards signals and
# does not create an extra session layer.
exec gosu app "$@"
