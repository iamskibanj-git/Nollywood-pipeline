#!/bin/bash
#
# git-safe.sh — Wrapper for git on FUSE mounts that don't support unlink/delete.
#
# Problem: The workspace is on a bindfs/FUSE mount where rm/unlink is "Operation
# not permitted". Git requires unlink for: index.lock cleanup, temp objects, checkout.
#
# Solution: Copy .git to a local ext4 filesystem (/tmp), run git there, then sync
# changed files back to the FUSE mount using overwrite (which works).
#
# Usage:
#   ./scripts/git-safe.sh status
#   ./scripts/git-safe.sh add src/main/pipeline/orchestrator.js
#   ./scripts/git-safe.sh commit -m "message"
#   ./scripts/git-safe.sh log --oneline -5
#   ./scripts/git-safe.sh diff --stat
#
# The script handles the full cycle:
#   1. Copy .git → /tmp/.git-local (if not already there or stale)
#   2. Run git command with GIT_DIR=/tmp/.git-local, GIT_WORK_TREE=<repo>
#   3. Sync changed git files back to FUSE .git (pack files, refs, index, etc.)
#   4. Verify sync succeeded
#
# For commits, it also repacks to minimize files that need syncing.
#

set -e

# ── Configuration ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FUSE_GIT="$REPO_DIR/.git"
LOCAL_GIT="/tmp/.git-local-nollywood"
LOCK_FILE="$LOCAL_GIT/.sync-lock"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[git-safe]${NC} $1"; }
warn() { echo -e "${YELLOW}[git-safe]${NC} $1"; }
err() { echo -e "${RED}[git-safe]${NC} $1" >&2; }

# ── Step 1: Ensure local .git exists and is up-to-date ──
sync_to_local() {
  if [ ! -d "$LOCAL_GIT" ]; then
    log "Initializing local git mirror..."
    cp -r "$FUSE_GIT" "$LOCAL_GIT"
    rm -f "$LOCAL_GIT/index.lock"
    rm -f "$LOCAL_GIT/objects/maintenance.lock"*
    # Clean any stale .lock / .stale files
    find "$LOCAL_GIT" -name "*.lock*" -delete 2>/dev/null || true
    find "$LOCAL_GIT" -name "*.stale*" -delete 2>/dev/null || true
    log "Local mirror ready at $LOCAL_GIT"
  else
    # Check if FUSE .git has newer refs (another session may have committed)
    local fuse_ref=$(cat "$FUSE_GIT/refs/heads/main" 2>/dev/null)
    local local_ref=$(cat "$LOCAL_GIT/refs/heads/main" 2>/dev/null)
    if [ "$fuse_ref" != "$local_ref" ] && [ -n "$fuse_ref" ]; then
      warn "FUSE .git has different HEAD ($fuse_ref vs $local_ref) — re-syncing..."
      rm -rf "$LOCAL_GIT"
      cp -r "$FUSE_GIT" "$LOCAL_GIT"
      rm -f "$LOCAL_GIT/index.lock"
      find "$LOCAL_GIT" -name "*.lock*" -delete 2>/dev/null || true
      find "$LOCAL_GIT" -name "*.stale*" -delete 2>/dev/null || true
      log "Re-synced from FUSE"
    fi
  fi

  # Always ensure no stale lock
  rm -f "$LOCAL_GIT/index.lock" 2>/dev/null || true
}

# ── Step 2: Run git command ──
run_git() {
  GIT_DIR="$LOCAL_GIT" GIT_WORK_TREE="$REPO_DIR" git "$@"
}

# ── Step 3: Sync back to FUSE mount ──
# Uses cp (overwrite) since FUSE supports create+write but not unlink.
sync_to_fuse() {
  local cmd="$1"

  # Only sync for write operations
  case "$cmd" in
    add|commit|reset|merge|rebase|cherry-pick|revert|tag|branch|checkout|switch|restore)
      ;;
    *)
      return 0  # Read-only command — no sync needed
      ;;
  esac

  log "Syncing back to FUSE mount..."

  # Repack for minimal file count (single pack + index)
  GIT_DIR="$LOCAL_GIT" git repack -a -d --quiet 2>/dev/null || true

  # Sync pack files (overwrite existing, add new)
  for f in "$LOCAL_GIT/objects/pack/"*.pack "$LOCAL_GIT/objects/pack/"*.idx; do
    [ -f "$f" ] || continue
    local basename=$(basename "$f")
    cp "$f" "$FUSE_GIT/objects/pack/$basename" 2>/dev/null || true
  done

  # Sync refs
  cp "$LOCAL_GIT/refs/heads/main" "$FUSE_GIT/refs/heads/main" 2>/dev/null || true
  if [ -d "$LOCAL_GIT/refs/tags" ]; then
    for tag in "$LOCAL_GIT/refs/tags/"*; do
      [ -f "$tag" ] || continue
      local tname=$(basename "$tag")
      cp "$tag" "$FUSE_GIT/refs/tags/$tname" 2>/dev/null || true
    done
  fi

  # Sync index (critical for correct status on next session)
  cp "$LOCAL_GIT/index" "$FUSE_GIT/index" 2>/dev/null || true

  # Sync packed-refs if it exists
  [ -f "$LOCAL_GIT/packed-refs" ] && cp "$LOCAL_GIT/packed-refs" "$FUSE_GIT/packed-refs" 2>/dev/null || true

  # Verify
  local fuse_ref=$(cat "$FUSE_GIT/refs/heads/main" 2>/dev/null)
  local local_ref=$(cat "$LOCAL_GIT/refs/heads/main" 2>/dev/null)
  if [ "$fuse_ref" = "$local_ref" ]; then
    log "✓ Sync verified (HEAD: ${local_ref:0:7})"
  else
    err "✗ Sync FAILED — FUSE ref ($fuse_ref) != local ref ($local_ref)"
    err "  Local git is at: $LOCAL_GIT"
    err "  Run manually: cp $LOCAL_GIT/refs/heads/main $FUSE_GIT/refs/heads/main"
    return 1
  fi
}

# ── Main ──
if [ $# -eq 0 ]; then
  echo "Usage: $0 <git-command> [args...]"
  echo "Examples:"
  echo "  $0 status"
  echo "  $0 add file1.js file2.js"
  echo "  $0 commit -m 'My message'"
  echo "  $0 log --oneline -5"
  exit 1
fi

CMD="$1"

sync_to_local
run_git "$@"
GIT_EXIT=$?

if [ $GIT_EXIT -eq 0 ]; then
  sync_to_fuse "$CMD"
fi

exit $GIT_EXIT
