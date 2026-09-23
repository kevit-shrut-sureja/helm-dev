#!/usr/bin/env bash
# Tuned for a small steady footprint: the heap holds ~5MB of index plus the ring
# buffer, so a tight old-space and a small semi-space keep RSS down. The index
# build already runs in a throwaway child process.
exec node --max-old-space-size=64 --max-semi-space-size=1 "$(dirname "$0")/server.mjs" "$@"
