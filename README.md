# CloudSwitch

A minimal private dashboard to view status and start/stop two fixed cloud VMs — one AWS EC2 instance and one Azure VM (scaffolded, disabled by default) — that both run WireGuard VPN servers.

This is a personal utility for two specific, pre-existing machines. It does not create VMs, manage multiple accounts, or generalize to other cloud resources.

> ⚠️ **The API routes have no authentication of their own.** They enforce same-origin, which stops another website forging requests through your browser but does nothing against anyone who can reach the URL directly. Authentication has to come from in front of the app: the `127.0.0.1` bind locally, platform access control when hosted. **Do not remove `--hostname 127.0.0.1` from `dev`/`start` until something else is authenticating requests** — see [Security model](#security-model) and [Hosting](#hosting).

## What it does

- Shows current power state, public address, WireGuard port, and a read-only network-security posture check for each VM.
- Starts or stops the AWS EC2 instance via the AWS SDK v3 (`@aws-sdk/client-ec2`).
- Starts or stops the Azure VM via the Azure SDK (`@azure/identity`, `@azure/arm-compute`, `@azure/arm-network`), disabled by default until you set `AZURE_ENABLED=true`.
- Enforces same-origin on every API route (`src/lib/csrf.ts`), so another website cannot forge a start/stop through your browser.
- **Never** modifies Security Groups, NSGs, OS firewall rules, public IP assignment, routes, or WireGuard configuration. Those are separate, manual, human-reviewed actions — see [aws-setup.md](./docs/aws-setup.md) and `scripts/host-firewall-example.sh`.

Two setup helpers ship alongside it, neither of which CloudSwitch ever runs itself:

| Script | Purpose |
|---|---|
| `scripts/create-wireguard-server.sh` | Turns a fresh Ubuntu/Debian box into a WireGuard server with one client, printing the client config and a QR code. See [wireguard-server-setup.md](./docs/wireguard-server-setup.md) |
| `scripts/host-firewall-example.sh` | Reference-only `ufw` configuration for the VM's OS firewall. Read it fully — it can lock you out of SSH |

There is also `terraform/main.tf`, which provisions the VPC, subnet, Security Group, Elastic IP, and EC2 instance if you would rather not click through the console.

## Prerequisites

- **Node.js 20.9+** and npm — Next.js 16 dropped support for Node.js 18
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), authenticated (see below)
- An already-provisioned EC2 instance — see [aws-setup.md](./docs/aws-setup.md) to create one
- WireGuard running on that instance — see [wireguard-server-setup.md](./docs/wireguard-server-setup.md), which drives `scripts/create-wireguard-server.sh`
- An IAM identity with the permissions listed under [Minimum IAM permissions](#minimum-iam-permissions)
- Only if you enable Azure: the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) or service principal credentials — see [azure-setup.md](./docs/azure-setup.md)

## Installation

```bash
npm install
cp .env.example .env.local
# edit .env.local with your real values (see Environment configuration below)
npm run dev
```

Open http://127.0.0.1:3000.

## AWS CLI authentication

CloudSwitch uses the AWS SDK's **default credential provider chain** and has no credential-handling code of its own — `src/cloud/aws.ts` never references `AWS_ACCESS_KEY_ID`. Note what that does *not* mean: the chain it delegates to reads those variables from `process.env`, and Next.js populates `process.env` from `.env.local`. Keys placed there are stored in this project directory and will be used. Prefer ambient credentials, so no secret lives here at all.

Being signed into the AWS Console in a browser is **not** sufficient; the SDK needs credentials available to the Node.js process.

Preferred: **AWS IAM Identity Center (SSO)**, not long-lived IAM user access keys.

```bash
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>   # or rely on your default profile
aws sts get-caller-identity         # confirms credentials are active
```

If `aws sts get-caller-identity` fails with `NoCredentials` (or similar), CloudSwitch will show "AWS credentials not found or expired" on the AWS card until you resolve this.

## Finding your region and instance ID

```bash
aws ec2 describe-instances \
  --query "Reservations[].Instances[].[InstanceId,Placement.AvailabilityZone,State.Name]" \
  --output table
```

The region is the AZ minus its trailing letter (e.g. `us-east-1a` → `us-east-1`). If you haven't created the instance yet, see [aws-setup.md](./docs/aws-setup.md).

## Environment configuration

All variables are server-side only — none are prefixed `NEXT_PUBLIC_`, so none reach the browser.

| Variable | Meaning |
|---|---|
| `ALLOWED_HOSTS` | Comma-separated hostnames this app is legitimately reached on. Empty = loopback only (`127.0.0.1`, `localhost`, `::1`). **A hosted deployment must set this** to its public hostname; it fails closed, returning 403 to every API request if unset on a public host |
| `AWS_REGION` | Region of the EC2 instance, e.g. `us-east-1` |
| `AWS_INSTANCE_ID` | The EC2 instance ID, e.g. `i-0123456789abcdef0` |
| `AWS_VM_DISPLAY_NAME` | Label shown on the AWS card |
| `AZURE_ENABLED` | Must be exactly `true` to activate the Azure path |
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_VM_NAME` | Required only if `AZURE_ENABLED=true` |
| `AZURE_VM_DISPLAY_NAME` | Label shown on the Azure card |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | Service principal credentials for `DefaultAzureCredential` — see [azure-setup.md](./docs/azure-setup.md). Omit to fall back to `az login` / managed identity instead |
| `WIREGUARD_PORT` | WireGuard UDP port both VMs listen on (default `51820`) |
| `AWS_WIREGUARD_ALLOWED_CIDRS` | Comma-separated CIDRs the security-posture checker treats as "expected" for the WireGuard rule (default `0.0.0.0/0`, since roaming clients need it) |
| `AWS_ADMIN_ALLOWED_CIDR` | Your admin IP in `/32` notation, e.g. `203.0.113.10/32` — used only to recognize "SSH is correctly scoped" as a good finding; CloudSwitch never writes this into any Security Group |
| `AWS_EXPECTED_SECURITY_GROUP_ID` | The Security Group ID you expect attached to the instance; flagged if absent |
| `AZURE_WIREGUARD_ALLOWED_CIDRS`, `AZURE_ADMIN_ALLOWED_CIDR`, `AZURE_EXPECTED_NSG_NAME` | Azure equivalents of the three rows above |

Changing the actual allowed IP/CIDR for SSH or WireGuard is always a manual action in the AWS/Azure console or CLI — CloudSwitch only *reads and reports* on these values.

## Local startup

```bash
npm run dev     # http://127.0.0.1:3000, hot reload
npm run build   # production build
npm run start   # production server, still bound to 127.0.0.1
npm test        # Vitest — no live AWS/Azure calls, safe to run anytime
npm run lint
```

## Minimum IAM permissions

Attach a policy scoped to exactly this instance. Mutating actions (start/stop) are restricted to the specific instance ARN; read-only describe actions require `Resource: "*"` because EC2's describe-style APIs don't support resource-level scoping (an AWS limitation, not a CloudSwitch choice). **No Security Group-mutating actions** (`AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupIngress`, etc.) are ever requested or used — CloudSwitch only reads Security Group configuration to report posture, never changes it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InstanceControl",
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances"],
      "Resource": "arn:aws:ec2:REGION:ACCOUNT_ID:instance/i-xxxxxxxxxxxxxxxxx"
    },
    {
      "Sid": "ReadOnlyDescribe",
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeAddresses"],
      "Resource": "*"
    }
  ]
}
```

Do not apply this policy automatically — review it, fill in your account ID/instance ARN, and attach it yourself (see [aws-setup.md](./docs/aws-setup.md) for the CLI commands to do so).

## Azure setup

Azure support is disabled by default (`src/cloud/azure.ts`). With `AZURE_ENABLED` unset or not exactly `true`, the Azure card always shows "not configured" and never breaks AWS functionality, even if Azure env vars are missing or wrong.

To enable it, see [azure-setup.md](./docs/azure-setup.md) for the one-time service principal setup, then fill in the Azure variables in [Environment configuration](#environment-configuration).

CloudSwitch uses `DefaultAzureCredential` and `ComputeManagementClient`/`NetworkManagementClient` from the Azure SDK. Critically, "stop" calls deallocate (`beginDeallocateAndWait`), not just an OS-level shutdown — otherwise compute allocation (and billing) isn't actually released.

### Minimum Azure role assignments

Scoped to exactly the VM's resource group — never subscription-wide:

- **Virtual Machine Contributor** — start/stop/read the VM.
- **Reader** — read the NSG, network interface, and public IP for the security-posture check. **No NSG-mutating role** (`Network Contributor` or similar) is ever requested — CloudSwitch only reads NSG configuration to report posture, never changes it.

See [azure-setup.md](./docs/azure-setup.md) for the `az` CLI commands to create these.

## Security model

Two layers, and they answer different questions:

| Layer | What it stops | What it does **not** stop |
|---|---|---|
| Reachability — the `127.0.0.1` bind locally, platform auth when hosted | Anyone who cannot reach the URL | Nothing, once the URL is reachable |
| Same-origin guard (`src/lib/csrf.ts`) | Another site forging requests through your logged-in browser | Anyone hitting the API directly with `curl` |

Neither is sufficient alone. The guard is not authentication, and reachability is not CSRF protection — the browser is already on loopback, so a local bind never protected against a malicious page. CloudSwitch has no login system of its own, by design; see [Hosting](#hosting).

The guard validates the `Host` header against `ALLOWED_HOSTS` before trusting `Sec-Fetch-Site`, falling back to an `Origin` comparison. It rejects with 403: cross-site requests, requests carrying neither header (plain `curl`), and DNS-rebound requests arriving on loopback with a foreign `Host`.

CloudSwitch also never modifies Security Groups, NSGs, OS firewall rules, public IPs, routes, or WireGuard configuration — see [WireGuard and network security](#wireguard-and-network-security) and [aws-setup.md](./docs/aws-setup.md) for how those are configured, manually, by you.

## Hosting

The `dev` and `start` scripts hardcode `--hostname 127.0.0.1`. That flag is doing real security work locally: it is what makes the unauthenticated API unreachable. A hosting platform needs the app to accept its traffic, so deploying means removing it — **and removing it is exactly the moment the app stops being protected by unreachability.**

Before that flag comes out, both of these must be true:

1. **Authentication is enforced in front of the app.** Azure App Service Easy Auth, Cloudflare Access, or Tailscale. Do not write your own login for this.
2. **`ALLOWED_HOSTS` is set** to the deployment's public hostname, so the same-origin guard knows what host to expect.

Why the guard still matters behind Easy Auth: platform authentication is cookie-based, so once you are signed in, your browser attaches that cookie to *any* request — including one forged by another site you happen to visit. Easy Auth answers "who are you"; the same-origin guard answers "did this request really come from this app". You need both.

On Azure App Service specifically, enable a **managed identity** and leave `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` unset — `DefaultAzureCredential` uses it automatically, and the long-lived client secret stops existing. AWS credentials still have to be static there; put them in application settings or a Key Vault reference, never in a deployed file.

## WireGuard and network security

Both VMs run WireGuard, listening on UDP `WIREGUARD_PORT` (default `51820`).

**Public UDP 51820 is normal and expected**, not a vulnerability, for a roaming WireGuard endpoint: WireGuard authenticates every peer cryptographically before responding at all, and silently drops packets from unrecognized sources. An open UDP port here is not equivalent to an open TCP service — there's no unauthenticated attack surface behind it. WireGuard must run over **UDP, not TCP** — the security-posture checker specifically flags a TCP rule on the WireGuard port as a warning, since it likely indicates a misconfiguration or an unrelated service on that port.

### Expected AWS Security Group posture

- A dedicated Security Group for the instance (never the default SG).
- One inbound rule: UDP, port `WIREGUARD_PORT`, source `0.0.0.0/0` (or your configured CIDR list).
- SSH, only if unavoidable: TCP 22, source your admin IP in `/32` notation only — **never** `0.0.0.0/0`. Prefer [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html) instead of public SSH; once confirmed working, remove the SSH rule entirely.
- No HTTP/HTTPS/ICMP/RDP/database/application ports unless you separately need them.

### Expected Azure NSG posture

Same shape: a dedicated NSG, one UDP WireGuard rule, SSH (if any) scoped to your admin IP only — never the whole internet. Prefer Azure Bastion or Serial Console over public SSH/RDP.

### Host firewall (Ubuntu)

`scripts/host-firewall-example.sh` is a **reference-only** `ufw` script — CloudSwitch never runs it. It documents: default-deny inbound, allow the WireGuard UDP port, allow SSH only from your admin IP if kept, allow established/related traffic, allow the WireGuard interface, and forwarding rules between the WireGuard interface and your external interface (needed if the VM acts as a full-tunnel gateway). Read the whole file — including the lockout warning — before running it yourself.

Gateway-mode (full-tunnel) VPN also needs:

```text
net.ipv4.ip_forward=1   # in /etc/sysctl.conf, then `sysctl -p`
```

plus a NAT/MASQUERADE rule from the WireGuard interface out through your external interface. Don't assume the external interface is `eth0` — check with `ip route show default` (the script does this automatically).

### Stable public addresses

Associate an **Elastic IP** with the EC2 instance (see [aws-setup.md](./docs/aws-setup.md)) — without one, the instance's public IP can change every time you stop/start it, breaking every client's WireGuard config. For Azure, use a **Standard SKU static Public IP** for the same reason.

### Security posture states

The read-only posture check reports one of: **Expected exposure**, **Restricted exposure**, **Warning**, or **Unable to verify** — never simply "secure." It flags: SSH/RDP open to the internet, all-ports/all-protocols open, WireGuard configured as TCP, unexpected public ports, a missing expected Security Group/NSG, no stable public IP, or unintended public IPv6 reachability. It never shows private keys, preshared keys, full WireGuard configs, or cloud credentials.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| AWS card shows "credentials not found or expired" | Run `aws sso login` again; confirm with `aws sts get-caller-identity` |
| AWS card shows "instance was not found" | `AWS_REGION` doesn't match where the instance actually lives, or `AWS_INSTANCE_ID` is wrong — re-check with `aws ec2 describe-instances` |
| AWS card shows "lack permission for this action" | The IAM policy above isn't attached to the identity your CLI/SDK resolves to |
| AWS card shows "AWS is rate-limiting requests" | Wait a few seconds and refresh; this is AWS API throttling, not a CloudSwitch bug |
| Security posture shows "Unable to verify" | Usually `ec2:DescribeSecurityGroups`/`ec2:DescribeAddresses` isn't granted, or the describe call failed — check server-side logs (never shown in the browser) |
| Azure card always shows "not configured" | Expected until `AZURE_ENABLED=true` and `AZURE_SUBSCRIPTION_ID`/`AZURE_RESOURCE_GROUP`/`AZURE_VM_NAME` are set — see [azure-setup.md](./docs/azure-setup.md) |
| Azure card shows "credentials not found or expired" | Run `az login` again, or check `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` in `.env.local` |
| Azure card shows "VM was not found" | `AZURE_RESOURCE_GROUP` or `AZURE_VM_NAME` doesn't match an existing VM — re-check with `az vm list` |
| Azure card shows "lack permission for this action" | The role assignments from [azure-setup.md](./docs/azure-setup.md) aren't attached to the service principal your credentials resolve to |
| Every API call returns 403 "Request host is not allowed" | You are reaching the app on a hostname that isn't loopback and isn't in `ALLOWED_HOSTS`. Set `ALLOWED_HOSTS` to the hostname you actually browse to. This is the guard failing closed, as intended |
| API returns 403 "Cross-origin request rejected" | The request did not come from the app's own page. Expected for `curl` and for another site's JavaScript; if the dashboard itself hits this, check that you are not reaching it through a proxy that rewrites `Origin` or `Host` |
| API returns 403 "Request is missing origin information" | The client sent neither `Sec-Fetch-Site` nor `Origin` — normal for `curl`. Add `-H "Sec-Fetch-Site: same-origin"` when testing by hand |
| `npm run dev` fails on an unsupported Node version | Next.js 16 requires Node.js 20.9+; check with `node --version` |
