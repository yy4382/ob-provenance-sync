#!/bin/sh
# Installs or updates the provenance sync server on a host that has Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/yy4382/ob-provenance-sync/main/deploy/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --domain sync.example.com    # with automatic HTTPS
#
# Options: --domain <name>  serve HTTPS for <name> through Caddy (DNS must point here; ports 80/443)
#          --port <n>       plain HTTP port when no domain is given (default 8787)
#          --dir <path>     where config and data live (default ~/provenance-sync)
#          --image <ref>    server image (default ghcr.io/yy4382/ob-provenance-sync-server:latest)
# Re-running keeps the existing config and tokens and updates the containers.
set -eu

IMAGE="ghcr.io/yy4382/ob-provenance-sync-server:latest"
DIR="${HOME}/provenance-sync"
DOMAIN=""
PORT="8787"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/engine/install/" >&2; exit 1; }
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

token() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

mkdir -p "$DIR/data"
CONFIG="$DIR/data/config.json"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<EOF
{
  "port": 8787,
  "dataDir": "/data",
  "tokens": [
    { "role": "device", "name": "devices", "token": "$(token)" },
    { "role": "agent", "name": "agents", "token": "$(token)" }
  ]
}
EOF
  chmod 600 "$CONFIG"
  echo "Created $CONFIG"
fi

$DOCKER pull "$IMAGE"
$DOCKER network create provenance >/dev/null 2>&1 || true
$DOCKER rm -f provenance-server >/dev/null 2>&1 || true

if [ -n "$DOMAIN" ]; then
  $DOCKER run -d --name provenance-server --restart unless-stopped --network provenance \
    -v "$DIR/data:/data" "$IMAGE" >/dev/null
  $DOCKER rm -f provenance-caddy >/dev/null 2>&1 || true
  $DOCKER run -d --name provenance-caddy --restart unless-stopped --network provenance \
    -p 80:80 -p 443:443 -v provenance-caddy:/data caddy:2 \
    caddy reverse-proxy --from "$DOMAIN" --to provenance-server:8787 >/dev/null
  URL="https://$DOMAIN"
else
  $DOCKER run -d --name provenance-server --restart unless-stopped --network provenance \
    -p "$PORT:8787" -v "$DIR/data:/data" "$IMAGE" >/dev/null
  URL="http://<this-server's-address>:$PORT"
fi

field() { grep "\"role\": \"$1\"" "$CONFIG" | head -1 | sed 's/.*"token": "\([^"]*\)".*/\1/'; }

cat <<EOF

Provenance sync server is running.

  Server URL    $URL
  Device token  $(field device)
  Agent token   $(field agent)

In Obsidian: install the plugin with BRAT from yy4382/ob-provenance-sync,
then enter the server URL and device token in its settings.
Remote agents: MCP over HTTP at $URL/mcp/<vault-id>?agent=<name>,
with the header "Authorization: Bearer <agent token>".
Config and data: $DIR/data (edit config.json to add tokens, then re-run this script).
EOF
[ -n "$DOMAIN" ] || echo "Without --domain the server speaks plain HTTP; use --domain for HTTPS before syncing over the internet."
