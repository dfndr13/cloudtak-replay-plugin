#!/usr/bin/env bash
#
# install.sh — deploy the CloudTAK Replay plugin into a CloudTAK checkout.
#
# Unlike a purely additive plugin (see e.g. the Dispatcher plugin, which never
# touches core files), Replay needs a tap into ConnectionPool.cots() to record
# live traffic, plus wiring through the stateless/stateful Hub split so the
# HTTP routes (which run in the stateless process) can reach it. That means
# four small, additive-only patches against CloudTAK core files, in addition
# to copying this plugin's own files into place:
#
#   • api/stateful/lib/connection-pool.ts   - records live CoT (skipping replay
#                                              echoes), tags outgoing features
#                                              with properties.replay
#   • api/stateless/config.ts               - carries a Recorder reference into
#                                              the stateless process (combined
#                                              'both' mode only - see below)
#   • api/index.ts                          - wires that Recorder reference in
#                                              at boot
#   • api/web/src/workers/atlas-database.ts - direct-write capture for drawn/
#                                              authored features (incl. ones
#                                              linked to a Mission) that never
#                                              reach ConnectionPool.cots()
#
# All four patches are additive-only (no lines removed) against CloudTAK
# 13.69.0. If a patch fails to apply cleanly on a different checkout, the
# surrounding code has likely moved since - diff the hunk context by hand and
# re-apply the same additions. See core-integration/README.md for exactly
# what each patch does and why.
#
# IMPORTANT: this plugin requires CLOUDTAK_Server_Mode=both (the default in
# CloudTAK's own docker-compose.yml). Recorder lives on the stateful
# ConnectionPool and there is no Hub RPC equivalent for a true split
# stateful/stateless deployment, so recording is unavailable in standalone
# 'api' mode - config.recorder is simply undefined there, and this script
# still installs everything (playback/export/import of already-recorded
# events works fine in 'api' mode; only new recording does not).
#
# Usage:
#   Install:  ./install.sh [/path/to/CloudTAK]
#   Update:   ./install.sh --pull [/path/to/CloudTAK]      (git pull, then reinstall + rebuild)
#   Remove:   ./install.sh --remove [/path/to/CloudTAK]
#
# Options:
#   /path/to/CloudTAK   Your CloudTAK checkout (the dir containing docker-compose.yml).
#                       Defaults to ~/CloudTAK.
#   --pull              git pull this plugin repo first, so you get the latest version.
#   --no-build          Copy/patch files only; skip the docker rebuild + restart.
#   --remove            Uninstall: reverse the patches, delete the copied files, rebuild.
#                       Does NOT drop the replay_events/replay_cot tables or their data.
#
# Requires: bash; git (CloudTAK checkout must be a git working tree, so the
# patches can be applied/reversed with `git apply`; also needed for --pull);
# and (unless --no-build) docker + docker compose.

set -euo pipefail

# --- resolve this repo's location (so the script works from any cwd) ---------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    sed -n '/^# Usage:/,/^# Requires:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- parse args --------------------------------------------------------------------
CT_DIR=""
DO_BUILD=1
DO_PULL=0
ACTION="install"
for arg in "$@"; do
    case "$arg" in
        --pull)     DO_PULL=1 ;;
        --no-build) DO_BUILD=0 ;;
        --remove)   ACTION="remove" ;;
        -h|--help)  usage; exit 0 ;;
        -*)         echo "Unknown option: $arg" >&2; echo >&2; usage >&2; exit 2 ;;
        *)          CT_DIR="$arg" ;;
    esac
done
CT_DIR="${CT_DIR:-$HOME/CloudTAK}"

# --- validate the CloudTAK checkout ------------------------------------------------
if [ ! -d "$CT_DIR" ]; then
    echo "ERROR: CloudTAK dir not found: $CT_DIR" >&2
    echo "       Pass the path explicitly:  ./install.sh /path/to/CloudTAK" >&2
    exit 1
fi
if [ ! -d "$CT_DIR/api" ]; then
    echo "ERROR: $CT_DIR does not look like a CloudTAK checkout (no api/ dir)." >&2
    exit 1
fi
if [ ! -d "$CT_DIR/.git" ]; then
    echo "ERROR: $CT_DIR is not a git working tree - the core-file patches need" >&2
    echo "       \`git apply\` to go in (and back out on --remove) cleanly." >&2
    exit 1
fi
if [ "$DO_BUILD" -eq 1 ] && [ ! -f "$CT_DIR/docker-compose.yml" ]; then
    echo "ERROR: no docker-compose.yml in $CT_DIR — cannot rebuild." >&2
    echo "       Re-run with --no-build to install files only, then rebuild yourself." >&2
    exit 1
fi

# CloudTAK 13.45+ (hub/api split) is required - this plugin's routes/libs use
# ConfigStateless and the api/stateful vs api/stateless layout throughout.
if [ ! -d "$CT_DIR/api/stateless/routes" ] || [ ! -d "$CT_DIR/api/stateful/lib" ]; then
    echo "ERROR: this CloudTAK predates the 13.45 hub/api split (no api/stateless/routes"  >&2
    echo "       or api/stateful/lib). This plugin requires CloudTAK >= 13.45 — update CloudTAK first." >&2
    exit 1
fi

WEB_DEST="$CT_DIR/api/web/plugins/replay"
ROUTES_DEST="$CT_DIR/api/stateless/routes/replay.ts"
PLAYER_DEST="$CT_DIR/api/stateless/lib/replay-player.ts"
RETENTION_DEST="$CT_DIR/api/stateless/lib/retention/replay.ts"
RECORDER_DEST="$CT_DIR/api/stateful/lib/replay-recorder.ts"
TEST_DEST="$CT_DIR/api/test/replay-retention.srv.test.ts"

# Patches: name -> (patch file relative to this repo, target file relative to CT_DIR, unique marker string)
PATCHES_PATCH=(
    "core-integration/api/stateful/lib/connection-pool.ts.patch"
    "core-integration/api/stateless/config.ts.patch"
    "core-integration/api/index.ts.patch"
    "core-integration/api/web/src/workers/atlas-database.ts.patch"
)
PATCHES_TARGET=(
    "api/stateful/lib/connection-pool.ts"
    "api/stateless/config.ts"
    "api/index.ts"
    "api/web/src/workers/atlas-database.ts"
)
PATCHES_MARKER=(
    "replay-recorder.js"
    "replay-recorder.js"
    "stateful.conns.recorder"
    "recordingActive"
)

echo "CloudTAK:  $CT_DIR"
echo "Plugin:    $REPO_DIR"
echo "Action:    $ACTION"
echo

# --- optional self-update of the plugin repo ---------------------------------------
if [ "$DO_PULL" -eq 1 ]; then
    if [ ! -d "$REPO_DIR/.git" ]; then
        echo "ERROR: --pull given but $REPO_DIR is not a git checkout." >&2
        exit 1
    fi
    echo "Pulling latest plugin source..."
    git -C "$REPO_DIR" pull
    echo
fi

if [ "$ACTION" = "remove" ]; then
    # --- uninstall -----------------------------------------------------------------
    for i in "${!PATCHES_PATCH[@]}"; do
        patchfile="$REPO_DIR/${PATCHES_PATCH[$i]}"
        target="$CT_DIR/${PATCHES_TARGET[$i]}"
        marker="${PATCHES_MARKER[$i]}"
        if [ -f "$target" ] && grep -q "$marker" "$target"; then
            if (cd "$CT_DIR" && git apply -R --check "$patchfile" 2>/dev/null); then
                (cd "$CT_DIR" && git apply -R "$patchfile")
                echo "Reversed patch: ${PATCHES_TARGET[$i]}"
            else
                echo "WARNING: could not cleanly reverse ${PATCHES_TARGET[$i]} (it has probably" >&2
                echo "         been edited since). Remove the replay-related hunks by hand -" >&2
                echo "         see core-integration/README.md for what each patch added." >&2
            fi
        fi
    done

    for f in "$ROUTES_DEST" "$PLAYER_DEST" "$RETENTION_DEST" "$RECORDER_DEST" "$TEST_DEST"; do
        if [ -f "$f" ]; then
            rm -f "$f"
            echo "Removed: ${f#$CT_DIR/}"
        fi
    done
    if [ -d "$WEB_DEST" ]; then
        rm -rf "$WEB_DEST"
        echo "Removed web plugin: api/web/plugins/replay"
    fi

    echo
    echo "Note: replay_events/replay_cot tables and their data are left in place."
    echo "      Drop them yourself if you want the recordings gone too."
else
    # --- install / update ----------------------------------------------------------
    if [ ! -d "$REPO_DIR/plugin/replay" ]; then
        echo "ERROR: $REPO_DIR/plugin/replay not found — run this from the plugin repo." >&2
        exit 1
    fi

    mkdir -p "$CT_DIR/api/web/plugins" "$CT_DIR/api/stateless/routes" \
             "$CT_DIR/api/stateless/lib/retention" "$CT_DIR/api/stateful/lib" \
             "$CT_DIR/api/test"

    # Web plugin: replace the dir wholesale so removed files don't linger.
    rm -rf "$WEB_DEST"
    cp -R "$REPO_DIR/plugin/replay" "$WEB_DEST"
    echo "Installed web plugin: api/web/plugins/replay"

    cp "$REPO_DIR/core-integration/api/stateless/routes/replay.ts" "$ROUTES_DEST"
    echo "Installed server route: api/stateless/routes/replay.ts"

    cp "$REPO_DIR/core-integration/api/stateless/lib/replay-player.ts" "$PLAYER_DEST"
    echo "Installed: api/stateless/lib/replay-player.ts"

    cp "$REPO_DIR/core-integration/api/stateless/lib/retention/replay.ts" "$RETENTION_DEST"
    echo "Installed: api/stateless/lib/retention/replay.ts (auto-discovered by Retention.init())"

    cp "$REPO_DIR/core-integration/api/stateful/lib/replay-recorder.ts" "$RECORDER_DEST"
    echo "Installed: api/stateful/lib/replay-recorder.ts"

    cp "$REPO_DIR/core-integration/api/test/replay-retention.srv.test.ts" "$TEST_DEST"
    echo "Installed: api/test/replay-retention.srv.test.ts"

    echo
    for i in "${!PATCHES_PATCH[@]}"; do
        patchfile="$REPO_DIR/${PATCHES_PATCH[$i]}"
        target="$CT_DIR/${PATCHES_TARGET[$i]}"
        marker="${PATCHES_MARKER[$i]}"
        if [ -f "$target" ] && grep -q "$marker" "$target"; then
            echo "Already patched: ${PATCHES_TARGET[$i]} (skipping)"
            continue
        fi
        if (cd "$CT_DIR" && git apply --check "$patchfile" 2>/dev/null); then
            (cd "$CT_DIR" && git apply "$patchfile")
            echo "Applied patch: ${PATCHES_TARGET[$i]}"
        else
            echo "ERROR: patch did not apply cleanly: ${PATCHES_TARGET[$i]}" >&2
            echo "       This CloudTAK checkout has likely diverged from 13.69.0 around this" >&2
            echo "       file. Open $patchfile and re-apply the same additions by hand -" >&2
            echo "       core-integration/README.md explains what each hunk does." >&2
            exit 1
        fi
    done

    echo
    echo "NOTE: adding api/stateless/routes/replay.ts changes the API schema. If this"
    echo "      CloudTAK checkout has api/test/fixtures/get_schema.json under test, that"
    echo "      fixture will need regenerating or schema.srv.test.ts will fail."
    echo
    echo "NOTE: recording requires CLOUDTAK_Server_Mode=both (CloudTAK's own compose"
    echo "      default). In standalone 'api' mode config.recorder is undefined and"
    echo "      recording is unavailable, though playback/export/import of already-"
    echo "      recorded events still work."
fi

echo

# --- rebuild -----------------------------------------------------------------------
if [ "$DO_BUILD" -eq 0 ]; then
    echo "Skipped rebuild (--no-build). To apply, run in $CT_DIR:"
    echo "    docker compose build --no-cache api && docker compose up -d --force-recreate api"
    exit 0
fi

echo "Rebuilding CloudTAK API image — this takes 5–15 minutes..."
( cd "$CT_DIR" && docker compose build --no-cache api )
echo "Restarting CloudTAK API container..."
( cd "$CT_DIR" && docker compose up -d --force-recreate api )

echo
if [ "$ACTION" = "remove" ]; then
    echo "✓ Plugin removed."
else
    echo "✓ Plugin installed."
    echo "  → In CloudTAK: Settings → Refresh App to activate the new service worker."
    echo "    (Cmd+Shift+R does NOT work — the service worker intercepts requests.)"
    echo "    Or close all CloudTAK tabs and reopen. The plugin appears at the"
    echo "    bottom of the right-side menu."
fi
