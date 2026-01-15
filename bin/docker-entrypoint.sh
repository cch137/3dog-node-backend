#!/bin/sh
set -e

# Warn and fail if any .env* or *.key file exists (to avoid leaking secrets)
if find . -type f \( -name ".env*" -o -name "*.key" \) -print -quit | grep -q .; then
  echo "[entrypoint] ERROR: Detected secret-like file(s). Remove them before running:" >&2
  find . -type f \( -name ".env*" -o -name "*.key" \) -print >&2
  exit 1
fi

# Fail fast if dependencies are missing in the current working directory (WORKDIR)
if [ ! -d node_modules ]; then
  echo "[entrypoint] ERROR: node_modules not found in $(pwd)" >&2
  exit 1
fi

# Fail fast if the build output is missing (TypeScript compiled JS)
if [ ! -d dist ]; then
  echo "[entrypoint] ERROR: dist not found in $(pwd). Did you run the build step?" >&2
  exit 1
fi

exec "$@"