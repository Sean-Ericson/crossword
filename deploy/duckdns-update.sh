#!/bin/sh
# Point the DuckDNS name at this network's current public IP.
# Run every 5 minutes, e.g. crontab:  */5 * * * * /path/to/deploy/duckdns-update.sh
set -eu
here=$(dirname "$0")
. "$here/deploy.env"
result=$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=")
[ "$result" = "OK" ] || { echo "duckdns update failed: $result" >&2; exit 1; }
