#!/usr/bin/env bash
#
# install.sh — deploy the CloudTAK Replay plugin into a CloudTAK checkout.
#
# Unlike a purely additive plugin (see e.g. the Dispatcher plugin, which never
# touches core files), Replay needs a tap into ConnectionPool.cots() to record
# live traffic, plus wiring through the stateless/stateful Hub split so the
# HTTP routes (which run in the stateless process) can reach it. That means
# thirteen small patches against CloudTAK core files, in addition to copying
# this plugin's own files into place:
#
#   • api/stateful/lib/connection-pool.ts   - records live CoT (skipping replay
#                                              echoes), tags outgoing features
#                                              with properties.replay
#   • api/common/hub/index.ts,              - carry the replay flag from
#     api/stateful/lib/hub/local.ts,          hub.submitCots() through to
#     api/stateful/routes/cots.ts             ConnectionPool.cots()
#   • api/stateless/config.ts               - carries a Recorder reference into
#                                              the stateless process (combined
#                                              'both' mode only - see below)
#   • api/index.ts                          - wires that Recorder reference in
#                                              at boot
#   • api/common/defaults.ts, types.ts      - retention::replay::* settings
#   • tasks/retention/src/index.ts,         - run the replay retention task from
#     tasks/retention/src/tasks.ts,           the retention container
#     tasks/retention/test/tasks.test.ts
#   • app/src/workers/atlas-database.ts     - direct-write capture for drawn/
#                                              authored features (incl. ones
#                                              linked to a Mission) that never
#                                              reach ConnectionPool.cots()
#   • api/test/fixtures/get_schema.json     - adds the /replay/* routes to the
#                                              API schema test fixture
#
# Supported CloudTAK: v13.109.3 through v13.113.0 (every release in that range
# is checked). For older CloudTAK (the api/web layout, before 13.102) use
# plugin v1.1.1 (verified on 13.69.0). Every patch is checked before any is applied, so a checkout
# that doesn't match is left untouched. See core-integration/README.md for
# exactly what each patch does and why.
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

# CloudTAK 13.109.3+ is required: the web app lives in app/ (13.102+) and the
# patches target 13.109.3 - 13.113.0.
if [ ! -d "$CT_DIR/api/stateless/routes" ] || [ ! -d "$CT_DIR/api/stateful/lib" ]; then
    echo "ERROR: this CloudTAK predates the 13.45 hub/api split (no api/stateless/routes"  >&2
    echo "       or api/stateful/lib). This plugin requires CloudTAK >= 13.109.3 — update CloudTAK first." >&2
    exit 1
fi
if [ ! -d "$CT_DIR/app/src/workers" ]; then
    echo "ERROR: this CloudTAK still uses the old api/web layout (no app/src/workers)." >&2
    echo "       Plugin v1.2.0+ requires CloudTAK >= 13.109.3. For older CloudTAK" >&2
    echo "       use plugin v1.1.1 (verified on 13.69.0):  git -C \"$REPO_DIR\" checkout v1.1.1" >&2
    exit 1
fi

WEB_DEST="$CT_DIR/app/plugins/replay"
ROUTES_DEST="$CT_DIR/api/stateless/routes/replay.ts"
PLAYER_DEST="$CT_DIR/api/stateless/lib/replay-player.ts"
RETENTION_DEST="$CT_DIR/api/stateless/lib/retention/replay.ts"
RECORDER_DEST="$CT_DIR/api/stateful/lib/replay-recorder.ts"
TEST_DEST="$CT_DIR/api/test/replay-retention.srv.test.ts"
UNIT_TEST_DEST="$CT_DIR/api/test/replay-recorder.test.ts"

# Patches: name -> (patch file relative to this repo, target file relative to CT_DIR, unique marker string)
PATCHES_TARGET=(
    "api/stateful/lib/connection-pool.ts"
    "api/common/hub/index.ts"
    "api/stateful/lib/hub/local.ts"
    "api/stateful/routes/cots.ts"
    "api/stateless/config.ts"
    "api/index.ts"
    "api/common/defaults.ts"
    "api/common/types.ts"
    "tasks/retention/src/index.ts"
    "tasks/retention/src/tasks.ts"
    "tasks/retention/test/tasks.test.ts"
    "app/src/workers/atlas-database.ts"
    "api/test/fixtures/get_schema.json"
)
PATCHES_MARKER=(
    "replay-recorder.js"
    "replay?: boolean"
    "replay: req.replay"
    "replay: req.body.replay"
    "replay-recorder.js"
    "stateful.conns.recorder"
    "retention::replay::enabled"
    "retention::replay::enabled"
    "retention::replay::enabled"
    "name: 'replay'"
    "'feature', 'replay'"
    "recordingActive"
    "/replay/record/start"
)
PATCHES_PATCH=()
for target in "${PATCHES_TARGET[@]}"; do
    PATCHES_PATCH+=("core-integration/$target.patch")
done

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
    for (( i=${#PATCHES_PATCH[@]}-1; i>=0; i-- )); do
        patchfile="$REPO_DIR/${PATCHES_PATCH[$i]}"
        target="$CT_DIR/${PATCHES_TARGET[$i]}"
        marker="${PATCHES_MARKER[$i]}"
        if [ -f "$target" ] && grep -qF "$marker" "$target"; then
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

    for f in "$ROUTES_DEST" "$PLAYER_DEST" "$RETENTION_DEST" "$RECORDER_DEST" "$TEST_DEST" "$UNIT_TEST_DEST"; do
        if [ -f "$f" ]; then
            rm -f "$f"
            echo "Removed: ${f#$CT_DIR/}"
        fi
    done
    if [ -d "$WEB_DEST" ]; then
        rm -rf "$WEB_DEST"
        echo "Removed web plugin: app/plugins/replay"
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

    # Check every patch before touching anything, so a checkout that doesn't
    # match is left exactly as it was instead of half-installed.
    PENDING=()
    for i in "${!PATCHES_PATCH[@]}"; do
        patchfile="$REPO_DIR/${PATCHES_PATCH[$i]}"
        target="$CT_DIR/${PATCHES_TARGET[$i]}"
        if [ -f "$target" ] && grep -qF "${PATCHES_MARKER[$i]}" "$target"; then
            continue
        fi
        if ! (cd "$CT_DIR" && git apply --check "$patchfile" 2>/dev/null); then
            echo "ERROR: patch does not apply cleanly: ${PATCHES_TARGET[$i]}" >&2
            echo "       Nothing was changed. This plugin supports CloudTAK v13.109.3 - v13.113.0;" >&2
            echo "       this checkout has likely diverged around this file. Open $patchfile" >&2
            echo "       and re-apply the same additions by hand - core-integration/README.md" >&2
            echo "       explains what each hunk does." >&2
            exit 1
        fi
        PENDING+=("$i")
    done

    mkdir -p "$CT_DIR/app/plugins" "$CT_DIR/api/stateless/routes" \
             "$CT_DIR/api/stateless/lib/retention" "$CT_DIR/api/stateful/lib" \
             "$CT_DIR/api/test"

    # Web plugin: replace the dir wholesale so removed files don't linger.
    rm -rf "$WEB_DEST"
    cp -R "$REPO_DIR/plugin/replay" "$WEB_DEST"
    echo "Installed web plugin: app/plugins/replay"

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

    cp "$REPO_DIR/core-integration/api/test/replay-recorder.test.ts" "$UNIT_TEST_DEST"
    echo "Installed: api/test/replay-recorder.test.ts"

    echo
    for i in "${!PATCHES_PATCH[@]}"; do
        if [[ ! " ${PENDING[*]-} " == *" $i "* ]]; then
            echo "Already patched: ${PATCHES_TARGET[$i]} (skipping)"
            continue
        fi
        (cd "$CT_DIR" && git apply "$REPO_DIR/${PATCHES_PATCH[$i]}")
        echo "Applied patch: ${PATCHES_TARGET[$i]}"
    done

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
    echo "    docker compose build --no-cache api retention && docker compose up -d --force-recreate api retention"
    exit 0
fi

echo "Rebuilding CloudTAK API and retention images — this takes 5–15 minutes..."
( cd "$CT_DIR" && docker compose build --no-cache api retention )
echo "Restarting CloudTAK API and retention containers..."
( cd "$CT_DIR" && docker compose up -d --force-recreate api retention )

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
