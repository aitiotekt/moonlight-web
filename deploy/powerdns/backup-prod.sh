#!/usr/bin/env bash
# backup-prod.sh — cold backup of the PRODUCTION box in one dated ZIP, kept
# three deep, taken before every deploy so a broken one can be rolled back
# from files and not only from git.
#
#   ./backup-prod.sh            write /root/mw-backups/mw-prod-<UTC date>-<tag>.zip
#   ./backup-prod.sh --list     list the backups that are kept
#
# deploy-prod.sh --apply and deploy-packages.sh --apply call it first and stop
# if it fails. Restoring is by hand, step by step: README §"Cold backup and
# restore".
#
# What goes in, and why:
#   moonlight-web/     the whole production checkout, .git and the files git
#                      does not hold (.env, .env.bak-*, NEXT-STEPS.txt, certs/)
#   mw-packages/       the APT/DNF tree that deploy-packages.sh replaces
#   volumes/<name>/    the stack's docker volumes, copied file by file: zone DB,
#                      Caddy's certificates, rendezvous claims, ownership store
#   dumps/umami.sql    Umami's Postgres, as pg_dump — a live copy of the data
#                      directory would not be consistent, the dump is
#   dumps/zone-*.txt   every DNS zone as pdnsutil prints it, readable at a glance
#   system/            what lives outside the checkout and shapes the box:
#                      ufw and fail2ban rules, sshd drop-ins, docker's
#                      daemon.json, root's crontab
#   MANIFEST.txt       tag, commit, containers and image ids at backup time
#
# Not in it: the images themselves (a rollback rebuilds them from the previous
# tag), /root/.ssh, and the dev stack (moonlight-web-dev, mw-dev_* volumes).
#
# The ZIP is written by python3's zipfile (the box has no zip binary, and
# nothing is installed for this), readable by root only. Nothing is stopped:
# the copy runs next to the live services.
set -Eeuo pipefail
trap 'echo "backup-prod.sh: stopped at line $LINENO — \"$BASH_COMMAND\" failed (exit $?)" >&2' ERR

DEST=/root/mw-backups
KEEP=3
PROD="$HOME/moonlight-web"
STACK="$PROD/deploy/powerdns"
VOLUMES=(powerdns_pdns_data powerdns_caddy_data powerdns_caddy_config
         powerdns_mwrdv_data powerdns_mwproxy_data)
SYSTEM=(/etc/ufw /etc/fail2ban /etc/ssh/sshd_config.d /etc/docker/daemon.json)

main() {
    # `docker compose exec` keeps stdin open even with -T, and would drain
    # whatever feeds this shell: the rest of a script piped through
    # `ssh box bash -s`, or the next line pasted into the terminal.
    exec </dev/null
    if [[ "${1:-}" == "--list" ]]; then
        ls -lh "$DEST"/mw-prod-*.zip 2>/dev/null || echo "no backup in $DEST"
        exit 0
    fi
    if [[ -n "${1:-}" ]]; then
        echo "unknown option: $1 (only --list is accepted)" >&2
        exit 2
    fi
    if [[ "$(id -u)" != 0 ]]; then
        echo "refusing: run as root (docker volumes and /etc are read as root)" >&2
        exit 1
    fi
    if [[ ! -f "$STACK/.env" ]]; then
        echo "refusing: no $STACK/.env — is this really the production box?" >&2
        exit 1
    fi
    command -v python3 >/dev/null || { echo "refusing: python3 is missing" >&2; exit 1; }

    # Room for one more archive: about the size of the last one, or 1 GB the
    # first time. A deploy must not be the thing that fills the disk.
    mkdir -p "$DEST"
    chmod 700 "$DEST"
    local need_kb=1048576 last
    last="$(ls -1t "$DEST"/mw-prod-*.zip 2>/dev/null | head -1 || true)"
    [[ -n "$last" ]] && need_kb=$(( $(du -k "$last" | cut -f1) * 2 ))
    local free_kb
    free_kb="$(df -Pk "$DEST" | awk 'NR==2 {print $4}')"
    if (( free_kb < need_kb )); then
        echo "refusing: $((free_kb / 1024)) MB free in $DEST, $((need_kb / 1024)) MB wanted" >&2
        exit 1
    fi

    local stamp tag name
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    tag="$(git -C "$PROD" describe --tags --always HEAD)"
    name="mw-prod-${stamp}-${tag//\//_}"
    # Not `local`: the EXIT trap fires at the whole script's exit, after this
    # function's scope is gone, and `set -u` refuses an out-of-scope local.
    # The stage holds secrets (.env, a database dump): it goes whatever happens.
    stage="$(mktemp -d "$DEST/.stage-XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    mkdir -p "$stage/dumps" "$stage/system"

    echo "backup $name"

    # Dumps first: they are the part most likely to fail, and they say most.
    echo "  dumping Umami's Postgres…"
    (cd "$STACK" && docker compose exec -T umami-db pg_dump -U umami -d umami) \
        > "$stage/dumps/umami.sql"
    echo "  dumping the DNS zones…"
    local zone
    for zone in $(cd "$STACK" && docker compose exec -T pdns pdnsutil list-all-zones 2>/dev/null); do
        (cd "$STACK" && docker compose exec -T pdns pdnsutil list-zone "$zone") \
            > "$stage/dumps/zone-${zone%.}.txt"
    done

    crontab -l > "$stage/system/root-crontab.txt" 2>/dev/null || true

    {
        echo "backup : $name"
        echo "date   : $(date -u '+%F %T') UTC"
        echo "tag    : $tag"
        echo "commit : $(git -C "$PROD" rev-parse HEAD)"
        echo
        echo "## git status (files git does not hold are in the archive too)"
        git -C "$PROD" status --short --ignored
        echo
        echo "## containers"
        (cd "$STACK" && docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}')
        echo
        echo "## image ids"
        (cd "$STACK" && docker compose images)
    } > "$stage/MANIFEST.txt" 2>&1

    # One archive, several roots: "arcname=path" pairs, a directory taken whole.
    local -a items=("MANIFEST.txt=$stage/MANIFEST.txt" "dumps=$stage/dumps"
                    "moonlight-web=$PROD")
    [[ -d /root/mw-packages ]] && items+=("mw-packages=/root/mw-packages")
    local v src
    for v in "${VOLUMES[@]}"; do
        src="$(docker volume inspect --format '{{.Mountpoint}}' "$v" 2>/dev/null || true)"
        if [[ -n "$src" && -d "$src" ]]; then
            items+=("volumes/$v=$src")
        else
            echo "  warning: volume $v not found, left out" >&2
        fi
    done
    items+=("system/root-crontab.txt=$stage/system/root-crontab.txt")
    for src in "${SYSTEM[@]}"; do
        [[ -e "$src" ]] && items+=("system${src}=$src")
    done

    echo "  writing the archive…"
    python3 - "$stage/$name.zip" "${items[@]}" <<'PY'
import os, sys, zipfile
out, pairs = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for pair in pairs:
        arc, src = pair.split("=", 1)
        if os.path.isfile(src):
            z.write(src, arc)
            continue
        for root, dirs, files in os.walk(src):
            rel = os.path.relpath(root, src)
            base = arc if rel == "." else f"{arc}/{rel}"
            if not files and not dirs:
                z.write(root, base + "/")
            for f in files:
                p = os.path.join(root, f)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue          # sockets, fifos, dangling links
                z.write(p, f"{base}/{f}")
PY
    python3 -c 'import sys, zipfile; bad = zipfile.ZipFile(sys.argv[1]).testzip(); sys.exit(f"corrupt member: {bad}" if bad else 0)' \
        "$stage/$name.zip"
    chmod 600 "$stage/$name.zip"
    # Renamed into place only once complete, so the rotation below never
    # counts a half-written archive as one of the three.
    mv "$stage/$name.zip" "$DEST/$name.zip"
    echo "  $(du -h "$DEST/$name.zip" | cut -f1)  $DEST/$name.zip"

    local old
    while read -r old; do
        [[ -n "$old" ]] || continue
        echo "  rotation: removing $(basename "$old")"
        rm -f -- "$old"
    done < <(ls -1t "$DEST"/mw-prod-*.zip | tail -n +$((KEEP + 1)))

    echo "kept:"
    ls -1t "$DEST"/mw-prod-*.zip | sed 's/^/  /'
}

main "$@"
exit $?
