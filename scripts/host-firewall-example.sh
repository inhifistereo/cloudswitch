#!/usr/bin/env bash
# =============================================================================
# EXAMPLE ONLY — NOT EXECUTED BY CLOUDSWITCH, EVER.
#
# This is a reference for configuring the OS-level firewall (ufw) on the
# Ubuntu WireGuard VM itself. It is a DIFFERENT layer from the cloud Security
# Group / NSG, which you configure separately in the AWS/Azure console or CLI
# (see AWS_SETUP.md). CloudSwitch never runs this script, never inspects it,
# and never modifies host firewall rules automatically.
#
# READ EVERY LINE BEFORE RUNNING. Applying firewall rules incorrectly CAN
# LOCK YOU OUT of SSH access to this host. Before running this on a real
# server:
#   1. Have a way back in that does NOT depend on the rule you're about to
#      add (AWS Systems Manager Session Manager, Azure Serial Console, or a
#      cloud provider's browser-based console access).
#   2. Test on a disposable instance first if you're not sure.
#   3. Never flush existing rules blindly — this script only ADDS rules on
#      top of ufw's defaults; review `ufw status` before and after.
#
# This script refuses to run unless invoked with --i-understand, as a second
# safety gate on top of you having read this banner.
# =============================================================================
set -euo pipefail

if [[ "${1:-}" != "--i-understand" ]]; then
  echo "Refusing to run without --i-understand. Read this file before using it." >&2
  exit 1
fi

# ---- Configuration — edit these before running ------------------------------
WG_PORT="${WG_PORT:-51820}"                # matches WIREGUARD_PORT in .env.local
WG_INTERFACE="${WG_INTERFACE:-wg0}"        # WireGuard interface name
ADMIN_CIDR="${ADMIN_CIDR:-}"               # e.g. 203.0.113.10/32 — leave empty to skip SSH rule entirely
ENABLE_GATEWAY_FORWARDING="${ENABLE_GATEWAY_FORWARDING:-true}"  # set false if this VM is not a full-tunnel gateway

# Do NOT assume the external interface is eth0 — detect it.
EXTERNAL_INTERFACE="$(ip route show default | awk '/default/ {print $5; exit}')"
if [[ -z "$EXTERNAL_INTERFACE" ]]; then
  echo "Could not detect the external network interface via 'ip route show default'." >&2
  echo "Set EXTERNAL_INTERFACE manually and re-run." >&2
  exit 1
fi
echo "Detected external interface: $EXTERNAL_INTERFACE"

# ---- Default-deny inbound, allow outbound -----------------------------------
ufw default deny incoming
ufw default allow outgoing

# ---- Established/related is implicit in ufw's default inbound chain, but --
# ---- explicit here for clarity when adapting this to raw iptables/nftables.
# -A ufw-before-input -m state --state ESTABLISHED,RELATED -j ACCEPT

# ---- WireGuard --------------------------------------------------------------
ufw allow "${WG_PORT}/udp" comment 'WireGuard VPN'

# ---- SSH, only if unavoidable, only from the configured admin IP -----------
if [[ -n "$ADMIN_CIDR" ]]; then
  ufw allow from "$ADMIN_CIDR" to any port 22 proto tcp comment 'Admin SSH'
else
  echo "ADMIN_CIDR not set — skipping SSH rule. Prefer AWS SSM Session Manager / Azure Bastion instead."
fi

# ---- Traffic arriving on the WireGuard interface itself --------------------
ufw allow in on "$WG_INTERFACE"

# ---- Gateway mode: forward between the WireGuard tunnel and the external --
# ---- interface so VPN clients can reach the internet through this VM. -----
if [[ "$ENABLE_GATEWAY_FORWARDING" == "true" ]]; then
  ufw route allow in on "$WG_INTERFACE" out on "$EXTERNAL_INTERFACE"
  ufw route allow in on "$EXTERNAL_INTERFACE" out on "$WG_INTERFACE"

  echo
  echo "Gateway forwarding rules added. You still need:"
  echo "  1. IP forwarding enabled — add to /etc/sysctl.conf:"
  echo "       net.ipv4.ip_forward=1"
  echo "     then run: sysctl -p"
  echo "     (only add net.ipv6.ip_forward=1 if you intentionally support IPv6 clients)"
  echo "  2. NAT/MASQUERADE from the WireGuard interface out through"
  echo "     $EXTERNAL_INTERFACE — typically added to /etc/ufw/before.rules, e.g.:"
  echo "       *nat"
  echo "       :POSTROUTING ACCEPT [0:0]"
  echo "       -A POSTROUTING -s <WG_TUNNEL_SUBNET> -o $EXTERNAL_INTERFACE -j MASQUERADE"
  echo "       COMMIT"
fi

echo
echo "Rules staged. Review with 'ufw status verbose' BEFORE enabling with 'ufw enable'."
echo "Do not run 'ufw enable' over an SSH session unless you have a separate way back in."
