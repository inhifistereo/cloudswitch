#!/usr/bin/env bash
# =============================================================================
# Turns a fresh Ubuntu/Debian box into a WireGuard server with one client.
#
# Run this yourself, over SSH, on the box you want to become a WireGuard
# server. It is unrelated to CloudSwitch's own runtime config — nothing here
# reads or writes .env.local. See docs/wireguard-server-setup.md for full
# usage, configuration, and troubleshooting.
#
#   sudo bash scripts/create-wireguard-server.sh
#
# This script installs a package, generates keys, and enables a systemd
# service — it does NOT touch the OS firewall, NAT, or IP forwarding. See
# scripts/host-firewall-example.sh separately if you need that.
# =============================================================================
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "This script must be run as root (sudo bash $0)." >&2
  exit 1
fi

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: sudo bash $0 [--force]" >&2
      exit 1
      ;;
  esac
done

# ---- Configuration — override via env vars before running -------------------
WG_INTERFACE="${WG_INTERFACE:-wg0}"
WG_PORT="${WG_PORT:-51820}"                        # matches WIREGUARD_PORT in .env.local
WG_CLIENT_NAME="${WG_CLIENT_NAME:-client1}"
WG_USE_PRESHARED_KEY="${WG_USE_PRESHARED_KEY:-true}"
WG_GENERATE_QR="${WG_GENERATE_QR:-true}"           # prints a scannable QR code of the client config
WG_ENDPOINT_HOST="${WG_ENDPOINT_HOST:-}"            # empty = auto-detect this box's public IP

# WG_SERVER_ADDRESS and WG_CLIENT_ALLOWED_IPS are NOT derived from each other
# — if you override WG_SERVER_ADDRESS, override WG_CLIENT_ALLOWED_IPS to match
# its network, or the client's route through the tunnel will be wrong.
WG_SERVER_ADDRESS="${WG_SERVER_ADDRESS:-10.8.0.1/24}"
WG_CLIENT_ADDRESS="${WG_CLIENT_ADDRESS:-10.8.0.2/32}"
WG_CLIENT_ALLOWED_IPS="${WG_CLIENT_ALLOWED_IPS:-10.8.0.0/24}"

WG_DIR="/etc/wireguard"
SERVER_CONF="$WG_DIR/${WG_INTERFACE}.conf"
CLIENT_CONF="$WG_DIR/${WG_CLIENT_NAME}.conf"

# ---- Refuse to clobber an existing server without --force -------------------
if [[ -e "$SERVER_CONF" && "$FORCE" != "true" ]]; then
  echo "Error: $SERVER_CONF already exists. Re-run with --force to overwrite." >&2
  echo "WARNING: --force regenerates the SERVER keypair too, which breaks EVERY" >&2
  echo "previously distributed client config, not just $WG_CLIENT_NAME." >&2
  exit 1
fi
if [[ -e "$SERVER_CONF" && "$FORCE" == "true" ]]; then
  echo "WARNING: overwriting existing $SERVER_CONF — regenerating the server"
  echo "keypair invalidates every previously distributed client config."
fi

# ---- Install WireGuard (idempotent) ------------------------------------------
PACKAGES_NEEDED=()
command -v wg >/dev/null 2>&1 || PACKAGES_NEEDED+=(wireguard)
command -v curl >/dev/null 2>&1 || PACKAGES_NEEDED+=(curl)
if [[ "$WG_GENERATE_QR" == "true" ]]; then
  command -v qrencode >/dev/null 2>&1 || PACKAGES_NEEDED+=(qrencode)
fi

if [[ ${#PACKAGES_NEEDED[@]} -gt 0 ]]; then
  echo "Installing: ${PACKAGES_NEEDED[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${PACKAGES_NEEDED[@]}"
else
  echo "wireguard and curl already installed — skipping apt-get."
fi

# ---- Resolve the public endpoint clients will connect to --------------------
if [[ -z "$WG_ENDPOINT_HOST" ]]; then
  WG_ENDPOINT_HOST="$(curl -fsSL --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -z "$WG_ENDPOINT_HOST" ]]; then
    WG_ENDPOINT_HOST="$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$WG_ENDPOINT_HOST" ]]; then
    echo "Could not auto-detect a public IP. Set WG_ENDPOINT_HOST and re-run." >&2
    exit 1
  fi
  ENDPOINT_AUTO_DETECTED=true
else
  ENDPOINT_AUTO_DETECTED=false
fi

# ---- Generate keys ------------------------------------------------------------
umask 077
install -d -m 700 "$WG_DIR"

wg genkey | tee "$WG_DIR/server_private.key" | wg pubkey > "$WG_DIR/server_public.key"
wg genkey | tee "$WG_DIR/${WG_CLIENT_NAME}_private.key" | wg pubkey > "$WG_DIR/${WG_CLIENT_NAME}_public.key"

SERVER_PRIVATE_KEY="$(cat "$WG_DIR/server_private.key")"
SERVER_PUBLIC_KEY="$(cat "$WG_DIR/server_public.key")"
CLIENT_PRIVATE_KEY="$(cat "$WG_DIR/${WG_CLIENT_NAME}_private.key")"
CLIENT_PUBLIC_KEY="$(cat "$WG_DIR/${WG_CLIENT_NAME}_public.key")"

PRESHARED_KEY_LINE=""
if [[ "$WG_USE_PRESHARED_KEY" == "true" ]]; then
  wg genpsk > "$WG_DIR/${WG_CLIENT_NAME}_preshared.key"
  PRESHARED_KEY="$(cat "$WG_DIR/${WG_CLIENT_NAME}_preshared.key")"
  PRESHARED_KEY_LINE="PresharedKey = ${PRESHARED_KEY}"
fi

CLIENT_ADDRESS_NETWORK="${WG_CLIENT_ADDRESS%/*}"

# ---- Write the server config --------------------------------------------------
cat > "$SERVER_CONF" <<EOF
# Managed by scripts/create-wireguard-server.sh — generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# No PostUp/PostDown, no NAT/MASQUERADE, no net.ipv4.ip_forward here —
# this is not a full-tunnel gateway. See docs/wireguard-server-setup.md and
# scripts/host-firewall-example.sh if you need that later.
[Interface]
Address = ${WG_SERVER_ADDRESS}
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIVATE_KEY}

[Peer]
# ${WG_CLIENT_NAME}
PublicKey = ${CLIENT_PUBLIC_KEY}
${PRESHARED_KEY_LINE}
AllowedIPs = ${CLIENT_ADDRESS_NETWORK}/32
EOF
chmod 600 "$SERVER_CONF"

# ---- Write the client config ---------------------------------------------------
cat > "$CLIENT_CONF" <<EOF
# ${WG_CLIENT_NAME} — generated by scripts/create-wireguard-server.sh on $(hostname) at $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# SECURITY: contains this client's PRIVATE key. Copy this file off the
# server, then delete both it and ${WG_CLIENT_NAME}_private.key from the
# server — see this script's final output for the exact commands.
[Interface]
PrivateKey = ${CLIENT_PRIVATE_KEY}
Address = ${WG_CLIENT_ADDRESS}

[Peer]
PublicKey = ${SERVER_PUBLIC_KEY}
${PRESHARED_KEY_LINE}
Endpoint = ${WG_ENDPOINT_HOST}:${WG_PORT}
AllowedIPs = ${WG_CLIENT_ALLOWED_IPS}
PersistentKeepalive = 25
EOF
chmod 600 "$CLIENT_CONF"

# ---- Enable and start -----------------------------------------------------------
systemctl enable --now "wg-quick@${WG_INTERFACE}"
wg show "$WG_INTERFACE"

# ---- Summary ----------------------------------------------------------------------
echo
echo "================================================================="
echo "WireGuard server is up."
echo
echo "  Interface:        ${WG_INTERFACE} (systemd unit: wg-quick@${WG_INTERFACE}, enabled + started)"
echo "  Server config:     ${SERVER_CONF}"
echo "  Server public key: ${SERVER_PUBLIC_KEY}"
echo "  Listen port:       ${WG_PORT}/udp   (cloud Security Group must already allow this — see terraform/main.tf / docs/aws-setup.md)"
echo
echo "  Client:            ${WG_CLIENT_NAME}"
echo "  Client config:     ${CLIENT_CONF}"
if [[ "$ENDPOINT_AUTO_DETECTED" == "true" ]]; then
  echo "  Endpoint used:      ${WG_ENDPOINT_HOST}:${WG_PORT}   (auto-detected — VERIFY THIS is reachable, especially behind NAT or on a multi-homed box)"
else
  echo "  Endpoint used:      ${WG_ENDPOINT_HOST}:${WG_PORT}"
fi
echo
echo "----- BEGIN ${WG_CLIENT_NAME}.conf -----"
cat "$CLIENT_CONF"
echo "----- END ${WG_CLIENT_NAME}.conf -----"
echo
if [[ "$WG_GENERATE_QR" == "true" ]]; then
  echo "Scan with the WireGuard mobile app to import ${WG_CLIENT_NAME}.conf directly:"
  echo
  qrencode -t ansiutf8 < "$CLIENT_CONF"
  echo
fi
echo "SECURITY — do this now:"
echo "  1. Copy the client config off this server, e.g.:"
echo "       scp <user>@<this-host>:${CLIENT_CONF} ./${WG_CLIENT_NAME}.conf"
echo "     (or just copy the block printed above directly from your terminal)"
echo "  2. Delete it from the server — it contains the client's private key"
echo "     and is not needed here once copied:"
echo "       rm -f ${CLIENT_CONF} ${WG_DIR}/${WG_CLIENT_NAME}_private.key"
echo "  3. Import ${WG_CLIENT_NAME}.conf into your WireGuard client app and connect."
echo "     (or scan the QR code above, which encodes the same private key)"
echo "  4. Clear your terminal's scrollback once you're done — both the config"
echo "     text and QR code above contain the client's private key."
echo
echo "This script never touched firewall, NAT, or IP-forwarding settings."
echo "See scripts/host-firewall-example.sh and docs/wireguard-server-setup.md"
echo "if you need those separately."
echo "================================================================="
