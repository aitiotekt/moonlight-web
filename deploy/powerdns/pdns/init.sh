#!/bin/sh
# PowerDNS zone bootstrap, then hand off to the OFFICIAL startup wrapper.
# Mounted into the stock PowerDNS image and used as its entrypoint. Idempotent.
# Runs as the image's non-root "pdns" user — DNS (:5300) and API (:8081) are
# non-privileged ports, so no extra capabilities are needed.
#
#   MW_DOMAIN          parent zone (e.g. example.top)              [required]
#   MW_PUBLIC_IP       public IPv4 of this DNS box                 [required]
#   MW_PUBLIC_IP6      public IPv6 of this DNS box                 [optional]
#   PDNS_AUTH_API_KEY  REST API key (set via MW_PDNS_API_KEY in
#                      .env; consumed by the official wrapper)     [required]
set -eu

: "${MW_DOMAIN:?MW_DOMAIN is required (parent zone, e.g. example.top)}"
: "${MW_PUBLIC_IP:?MW_PUBLIC_IP is required (public IPv4 of this DNS server)}"
: "${PDNS_AUTH_API_KEY:?set MW_PDNS_API_KEY in .env (maps to PDNS_AUTH_API_KEY)}"

DB="/var/lib/powerdns/pdns.sqlite3"
SCHEMA="/usr/local/share/doc/pdns/schema.sqlite3.sql"
PDNSUTIL="pdnsutil --config-dir=/etc/powerdns"

# A named volume is auto-populated from the image's pre-created DB; this guard
# only matters for a fresh bind mount.
if [ ! -f "$DB" ]; then
    echo "[mw] SQLite DB missing — creating from schema"
    sqlite3 "$DB" < "$SCHEMA"
fi

# Create + populate the zone if absent.
if ! $PDNSUTIL list-all-zones 2>/dev/null | grep -qx "$MW_DOMAIN"; then
    echo "[mw] Creating zone $MW_DOMAIN -> $MW_PUBLIC_IP"
    $PDNSUTIL create-zone "$MW_DOMAIN"
    $PDNSUTIL add-record "$MW_DOMAIN" @   A  "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" www A  "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" stats A "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" stream A "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" ns1 A  "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" ns2 A  "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" api A  "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" dnsapi A "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" updates A "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" metrics A "$MW_PUBLIC_IP"
    $PDNSUTIL add-record "$MW_DOMAIN" @   NS "ns1.${MW_DOMAIN}."
    $PDNSUTIL add-record "$MW_DOMAIN" @   NS "ns2.${MW_DOMAIN}."
    $PDNSUTIL secure-zone "$MW_DOMAIN"
    $PDNSUTIL rectify-zone "$MW_DOMAIN"
    echo "[mw] Zone ready. DS record to submit to your registrar:"
    $PDNSUTIL export-zone-ds "$MW_DOMAIN" || true
else
    echo "[mw] Zone $MW_DOMAIN already exists — skipping init"
fi

# Ensure the presentation-site records exist even on a pre-existing zone (created
# before the website was added). Idempotent: only adds each when missing, so
# re-running on an already-deployed DNS box safely backfills www/apex/api.
ensure_a() {  # ensure_a <name>  — add an A record to MW_PUBLIC_IP if absent
    name="$1"
    fqdn="$( [ "$name" = "@" ] && echo "$MW_DOMAIN" || echo "${name}.${MW_DOMAIN}" )"
    if ! $PDNSUTIL list-zone "$MW_DOMAIN" 2>/dev/null \
         | grep -qiE "^${fqdn}\.?[[:space:]].*[[:space:]]A[[:space:]]"; then
        echo "[mw] Adding missing A record ${fqdn} -> $MW_PUBLIC_IP"
        $PDNSUTIL add-record "$MW_DOMAIN" "$name" A "$MW_PUBLIC_IP"
        NEED_RECTIFY=1
    fi
}
NEED_RECTIFY=0
ensure_a @      # apex   — presentation site
ensure_a www    # www    — presentation site
ensure_a api    # api    — PowerDNS REST API (direct, compatibility)
ensure_a dnsapi # dnsapi — restricted DNS-registration API (mw-proxy, 0.2.0+)
ensure_a stats  # stats  — Umami analytics dashboard
ensure_a updates # updates — update relay / version census (mw-proxy, 0.3.0+)
ensure_a metrics # metrics — session census (mw-proxy /v1/session, 0.3.0+). The
                 # Caddyfile's site block needs this record first: Caddy orders a
                 # certificate for every name it serves.
ensure_a stream # stream — rendezvous host: bootstrap page + /v1 API (0.3.0+)
# stream.dev — the staging rendezvous (docker-compose.dev.yml), same address:
# production's Caddy fronts it. A label of its own so MW_DOMAIN=dev.{domain} on
# a host moves rendezvous, STUN and the handed-out address together.
ensure_a stream.dev

# The same names over IPv6, once MW_PUBLIC_IP6 is set — plus ns1/ns2, which
# also need an IPv6 glue at the registrar. Any AAAA already on a name counts,
# so one added by hand during a name-by-name rollout is left alone. A refusal
# only warns: this is optional, and failing here would take the DNS down.
# Trimmed, because pdnsutil — unlike compose — chokes on a stray space.
MW_PUBLIC_IP6="$(printf '%s' "${MW_PUBLIC_IP6:-}" | tr -d '[:space:]')"
ensure_aaaa() {  # ensure_aaaa <name>  — add an AAAA record to MW_PUBLIC_IP6 if absent
    name="$1"
    fqdn="$( [ "$name" = "@" ] && echo "$MW_DOMAIN" || echo "${name}.${MW_DOMAIN}" )"
    if ! $PDNSUTIL list-zone "$MW_DOMAIN" 2>/dev/null \
         | grep -qiE "^${fqdn}\.?[[:space:]].*[[:space:]]AAAA[[:space:]]"; then
        echo "[mw] Adding missing AAAA record ${fqdn} -> $MW_PUBLIC_IP6"
        if $PDNSUTIL add-record "$MW_DOMAIN" "$name" AAAA "$MW_PUBLIC_IP6"; then
            NEED_RECTIFY=1
        else
            echo "[mw] WARN could not add AAAA ${fqdn} -> $MW_PUBLIC_IP6 (check MW_PUBLIC_IP6)"
        fi
    fi
}
if [ -n "$MW_PUBLIC_IP6" ]; then
    for n in @ www api dnsapi stats updates metrics stream stream.dev ns1 ns2; do
        ensure_aaaa "$n"
    done
fi

# The domain sends and receives no mail. Saying so in DNS keeps anyone from
# sending phishing "from" it, which is how a clean domain lands on a domain
# blocklist (Spamhaus DBL): an SPF that authorises no sender, a DMARC that has
# receivers reject what fails it, and a null MX (RFC 7505). Each is added only
# when its name carries nothing of the kind, so a fork that runs mail on its
# domain keeps its own records — it just has to set them before first boot.
ensure_rr() {  # ensure_rr <name> <type> <content-substring> <content>
    name="$1"; type="$2"; match="$3"; content="$4"
    fqdn="$( [ "$name" = "@" ] && echo "$MW_DOMAIN" || echo "${name}.${MW_DOMAIN}" )"
    if ! $PDNSUTIL list-zone "$MW_DOMAIN" 2>/dev/null \
         | grep -iE "^${fqdn}\.?[[:space:]].*[[:space:]]${type}[[:space:]]" \
         | grep -qF -- "$match"; then
        echo "[mw] Adding missing ${type} record ${fqdn} -> ${content}"
        $PDNSUTIL add-record "$MW_DOMAIN" "$name" "$type" "$content"
        NEED_RECTIFY=1
    fi
}
ensure_rr @      TXT 'v=spf1'   '"v=spf1 -all"'
ensure_rr _dmarc TXT 'v=DMARC1' '"v=DMARC1; p=reject"'
ensure_rr @      MX  ''         '0 .'   # any MX at all counts: mail is set up

# Zones created before default-soa-content was set (zz-mw.conf) carry the image
# placeholder SOA ("a.misconfigured.dns.server.invalid"); swap in a real one.
if $PDNSUTIL list-zone "$MW_DOMAIN" 2>/dev/null | grep -q 'misconfigured\.dns\.server\.invalid'; then
    echo "[mw] Replacing placeholder SOA for $MW_DOMAIN"
    $PDNSUTIL replace-rrset "$MW_DOMAIN" @ SOA 3600 \
        "ns1.${MW_DOMAIN}. hostmaster.${MW_DOMAIN}. $(date -u +%Y%m%d01) 10800 3600 604800 3600"
    NEED_RECTIFY=1
fi
[ "$NEED_RECTIFY" = "1" ] && $PDNSUTIL rectify-zone "$MW_DOMAIN" || true

# Hand off to the official wrapper: it renders the REST API config from
# PDNS_AUTH_API_KEY, then execs pdns_server.
echo "[mw] Starting PowerDNS (official wrapper)"
exec /usr/local/sbin/pdns_server-startup
