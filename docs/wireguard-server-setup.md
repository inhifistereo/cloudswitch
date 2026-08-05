# WireGuard server setup

`scripts/create-wireguard-server.sh` turns a fresh Ubuntu/Debian box into a working WireGuard server with one client, by running a single script over SSH. It is **not** cloud provisioning — it assumes the box already exists (e.g. the EC2 instance from [aws-setup.md](./aws-setup.md)) and only installs/configures WireGuard software on it. It doesn't read or write anything in CloudSwitch's own `.env.local`.

## Prerequisites

- Root/sudo access on the target box.
- Ubuntu or Debian (apt-based). Other distros aren't supported.
- Outbound internet access, for `apt-get install` and for auto-detecting the box's public IP.
- If you already know the box's public IP/hostname, have it ready — you can skip auto-detection (see `WG_ENDPOINT_HOST` below).

## Basic usage

SSH into the box, then:

```bash
sudo bash scripts/create-wireguard-server.sh
```

That's it — this installs WireGuard, generates a server keypair and one client keypair, writes the server and client configs, and enables the systemd service. The client config is printed to your terminal at the end so you can copy it straight off the box.

## Configuration

Everything is configured via env vars set inline when you invoke the script — nothing here is added to `.env.example`/`.env.local`, since this script is unrelated to CloudSwitch's own runtime config and runs on a separate box entirely.

```bash
sudo -E WG_CLIENT_NAME=phone WG_ENDPOINT_HOST=203.0.113.5 bash scripts/create-wireguard-server.sh
```

| Var | Default | Purpose |
|---|---|---|
| `WG_INTERFACE` | `wg0` | Interface name → `/etc/wireguard/<name>.conf` + `wg-quick@<name>` systemd unit |
| `WG_PORT` | `51820` | UDP listen port (matches `WIREGUARD_PORT` in `.env.example`) |
| `WG_SERVER_ADDRESS` | `10.8.0.1/24` | Server's tunnel IP/subnet |
| `WG_CLIENT_ADDRESS` | `10.8.0.2/32` | The client's tunnel IP |
| `WG_CLIENT_NAME` | `client1` | Used in filenames, the `[Peer]` comment, and printed labels |
| `WG_CLIENT_ALLOWED_IPS` | `10.8.0.0/24` | What the **client** routes through the tunnel — defaults to just the server's subnet, not `0.0.0.0/0` (this is a point-to-point tunnel, not a full-tunnel gateway) |
| `WG_ENDPOINT_HOST` | empty → auto-detect | Public IP/hostname clients use to reach this server |
| `WG_USE_PRESHARED_KEY` | `true` | Adds a WireGuard preshared key to the peer, for extra defense-in-depth |

`WG_SERVER_ADDRESS` and `WG_CLIENT_ALLOWED_IPS` aren't derived from each other — if you override `WG_SERVER_ADDRESS`, override `WG_CLIENT_ALLOWED_IPS` to match its network too, or the client's route through the tunnel will be wrong.

## What it does / does not do

Does:
- Installs the `wireguard` package (skipped if already present).
- Generates a server keypair and one client keypair (plus a preshared key by default).
- Writes `/etc/wireguard/<interface>.conf` (server) and `/etc/wireguard/<client-name>.conf` (client).
- Enables and starts `wg-quick@<interface>` via systemd.

Does **not**:
- Touch the OS firewall, NAT, or `net.ipv4.ip_forward` — see `scripts/host-firewall-example.sh` separately if you need that.
- Open anything at the cloud level — the Security Group / NSG must already allow the UDP port (see [aws-setup.md](./aws-setup.md)).
- Provision any infrastructure — it only configures software on a box that already exists.

## After running it

The script prints the full client config to your terminal and also writes it to disk. Do this immediately after:

1. Copy the client config off the server (copy the printed block, or `scp` the file).
2. Delete it from the server — it contains the client's private key and isn't needed there once copied:
   ```bash
   rm -f /etc/wireguard/<client-name>.conf /etc/wireguard/<client-name>_private.key
   ```
3. Import the config into your WireGuard client app and connect.

## Re-running / adding more clients

Re-running without `--force` refuses to touch an existing setup. Re-running with `--force` **regenerates the server keypair**, which invalidates every previously distributed client config, not just the current one — use it to start over, not to add a peer.

This script always writes a fresh single-peer server config — it doesn't currently support adding a second client to an existing server without disturbing the first. To do that today, hand-edit `/etc/wireguard/<interface>.conf` to add another `[Peer]` block with a new keypair (`wg genkey | tee ... | wg pubkey > ...`), then `wg syncconf <interface> <(wg-quick strip <interface>)` to apply it without restarting the tunnel.

## Troubleshooting

- **Client can't connect / times out**: the most common cause is the cloud Security Group not allowing the UDP port — verify with `docs/aws-setup.md`'s security group steps, not this script.
- **Auto-detected endpoint looks wrong**: re-run with `WG_ENDPOINT_HOST` set explicitly. Auto-detection can pick the wrong address on a NAT'd or multi-homed box.
- **Check live status**: `wg show <interface>` on the server.
