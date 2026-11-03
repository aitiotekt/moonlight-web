# Dedicated Caddy image: official Caddy + the caddy-ratelimit plugin (built via
# xcaddy). One process, one container — reverse-proxies the PowerDNS REST API
# over HTTPS with automatic TLS (or user-supplied cert files).
FROM caddy:2-builder AS builder
# -v makes `go build` print each package as it compiles; the installer counts
# those lines to render a live progress bar (Go has no native progress output).
# The plugin at a commit, not its branch: a build takes what was reviewed, and
# a new commit upstream reaches production only by changing this line
# (master on 26/10/2026, unchanged upstream since 12/06/2026).
RUN XCADDY_GO_BUILD_FLAGS="-v" xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Both templates go in: the same image serves production (Caddyfile.tmpl) and
# the staging rendezvous (Caddyfile.dev.tmpl, selected by MW_CADDYFILE_TMPL).
# stream.caddy is the site body they share.
COPY Caddyfile.tmpl     /etc/caddy/Caddyfile.tmpl
COPY Caddyfile.dev.tmpl /etc/caddy/Caddyfile.dev.tmpl
COPY stream.caddy       /etc/caddy/stream.caddy
COPY entrypoint.sh      /usr/local/bin/mw-caddy-entrypoint.sh
RUN chmod +x /usr/local/bin/mw-caddy-entrypoint.sh
# The presentation website (repo-root ./website) is bind-mounted at /srv/site
# by docker-compose — see the caddy service volumes.

EXPOSE 80/tcp 443/tcp
ENTRYPOINT ["/usr/local/bin/mw-caddy-entrypoint.sh"]
