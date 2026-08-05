import { EC2Client, DescribeSecurityGroupsCommand, DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { DefaultAzureCredential } from "@azure/identity";
import { NetworkManagementClient, type SecurityRule } from "@azure/arm-network";
import type { SecurityPosture, SecurityPostureState } from "@/types";

export interface AwsSgRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidrs: string[];
  ipv6Cidrs: string[];
}

export interface SgSnapshot {
  groupIds: string[];
  expectedGroupIdAttached: boolean;
  rules: AwsSgRule[];
}

export interface PostureInputs {
  wireguardPort: number;
  adminAllowedCidr?: string;
  wireguardAllowedCidrs: string[];
  expectedGroupConfigured: boolean;
  hasStablePublicIp: boolean;
  sg: SgSnapshot | null;
}

const SEVERITY_RANK: Record<SecurityPostureState, number> = {
  expected: 0,
  restricted: 1,
  warning: 2,
  unable_to_verify: 3,
};

function overlapsPort(rule: AwsSgRule, port: number): boolean {
  if (rule.protocol === "-1") return true;
  if (rule.fromPort === undefined || rule.toPort === undefined) return false;
  return rule.fromPort <= port && port <= rule.toPort;
}

function isAllPorts(rule: AwsSgRule): boolean {
  return rule.protocol === "-1" || (rule.fromPort === 0 && rule.toPort === 65535);
}

function describeCidrs(cidrs: string[]): string {
  if (cidrs.length === 0) return "no IPv4 sources";
  if (cidrs.length <= 3) return cidrs.join(", ");
  return `${cidrs.slice(0, 3).join(", ")} (+${cidrs.length - 3} more)`;
}

function describePortRange(rule: AwsSgRule): string {
  if (rule.fromPort === undefined || rule.toPort === undefined) return "all";
  if (rule.fromPort === rule.toPort) return `${rule.fromPort}`;
  return `${rule.fromPort}-${rule.toPort}`;
}

/**
 * Pure classification of a Security Group snapshot against expected WireGuard/admin posture.
 * No SDK calls, no network access — fully unit-testable with fabricated input.
 */
export function classifySecurityPosture(input: PostureInputs): SecurityPosture {
  if (input.sg === null) {
    return {
      state: "unable_to_verify",
      findings: ["Could not read security group rules (describe call failed or was not permitted)."],
    };
  }

  const findings: string[] = [];
  let worst: SecurityPostureState = "expected";
  const bump = (level: SecurityPostureState) => {
    if (SEVERITY_RANK[level] > SEVERITY_RANK[worst]) worst = level;
  };

  if (input.expectedGroupConfigured && !input.sg.expectedGroupIdAttached) {
    findings.push("Expected security group is not attached to this instance.");
    bump("warning");
  }

  if (!input.hasStablePublicIp) {
    findings.push("No Elastic IP / static public IP associated — the VPN endpoint address may change on stop/start.");
    bump("warning");
  }

  let wgRuleSeen = false;
  const expectedCidrSet = new Set(input.wireguardAllowedCidrs);

  for (const rule of input.sg.rules) {
    const publicV4 = rule.cidrs.includes("0.0.0.0/0");
    const publicV6 = rule.ipv6Cidrs.includes("::/0");
    const isPublic = publicV4 || publicV6;
    let ruleFlagged = false;

    if (isAllPorts(rule) && isPublic) {
      findings.push("All ports/protocols are open to the internet on this security group.");
      bump("warning");
      continue;
    }

    if (overlapsPort(rule, input.wireguardPort)) {
      wgRuleSeen = true;
      if (rule.protocol === "udp") {
        const isSubsetOfExpected = rule.cidrs.every((c) => expectedCidrSet.has(c));
        if (isSubsetOfExpected) {
          findings.push(
            `WireGuard UDP ${input.wireguardPort} is open to ${describeCidrs(rule.cidrs)} — expected for roaming VPN clients.`
          );
        } else {
          findings.push(
            `WireGuard UDP ${input.wireguardPort} is open to an unexpected range (${describeCidrs(rule.cidrs)}).`
          );
          bump("restricted");
        }
      } else if (rule.protocol === "tcp") {
        findings.push(
          `WireGuard port ${input.wireguardPort} is open as TCP, not UDP — WireGuard only uses UDP; this rule may be misconfigured.`
        );
        bump("warning");
      }
      ruleFlagged = true;
    }

    if (overlapsPort(rule, 22) && (rule.protocol === "tcp" || rule.protocol === "-1")) {
      if (isPublic) {
        findings.push("SSH (22) is open to the entire internet — restrict to your admin IP or use SSM Session Manager.");
        bump("warning");
      } else if (
        input.adminAllowedCidr &&
        rule.cidrs.length === 1 &&
        rule.cidrs[0] === input.adminAllowedCidr &&
        rule.ipv6Cidrs.length === 0
      ) {
        findings.push(`SSH is restricted to the configured admin CIDR (${input.adminAllowedCidr}).`);
      }
      ruleFlagged = true;
    }

    if (overlapsPort(rule, 3389) && (rule.protocol === "tcp" || rule.protocol === "-1") && isPublic) {
      findings.push("RDP (3389) is open to the entire internet.");
      bump("warning");
      ruleFlagged = true;
    }

    if (isPublic && !ruleFlagged) {
      findings.push(`Unexpected port(s) ${describePortRange(rule)}/${rule.protocol} open to the internet.`);
      bump("warning");
      ruleFlagged = true;
    }

    if (!ruleFlagged && publicV6) {
      findings.push(`Port ${describePortRange(rule)} is reachable over IPv6 from anywhere — verify this is intended.`);
      bump("warning");
    }
  }

  if (!wgRuleSeen) {
    findings.push(`No inbound rule found for WireGuard UDP ${input.wireguardPort} — VPN clients may not be able to connect.`);
    bump("warning");
  }

  if (findings.length === 0) {
    findings.push("No notable exposures detected against expected configuration.");
  }

  return { state: worst, findings };
}

export function parseCidrList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function readWireguardPort(): number {
  const raw = process.env.WIREGUARD_PORT;
  if (!raw) return 51820;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid WIREGUARD_PORT "${raw}" — falling back to default 51820.`);
    return 51820;
  }
  return parsed;
}

export async function getAwsSecurityPosture(params: {
  instanceId: string;
  region: string;
  groupIds: string[];
}): Promise<SecurityPosture> {
  try {
    const client = new EC2Client({ region: params.region });

    const [sgResult, addressResult] = await Promise.all([
      params.groupIds.length > 0
        ? client.send(new DescribeSecurityGroupsCommand({ GroupIds: params.groupIds }))
        : Promise.resolve({ SecurityGroups: [] }),
      client.send(
        new DescribeAddressesCommand({ Filters: [{ Name: "instance-id", Values: [params.instanceId] }] })
      ),
    ]);

    const expectedGroupId = process.env.AWS_EXPECTED_SECURITY_GROUP_ID?.trim();
    const expectedGroupConfigured = Boolean(expectedGroupId);
    const expectedGroupIdAttached = expectedGroupConfigured ? params.groupIds.includes(expectedGroupId!) : true;

    const rules: AwsSgRule[] = (sgResult.SecurityGroups ?? []).flatMap((sg) =>
      (sg.IpPermissions ?? []).map((perm) => ({
        protocol: perm.IpProtocol ?? "-1",
        fromPort: perm.FromPort,
        toPort: perm.ToPort,
        cidrs: (perm.IpRanges ?? []).map((r) => r.CidrIp).filter((c): c is string => Boolean(c)),
        ipv6Cidrs: (perm.Ipv6Ranges ?? []).map((r) => r.CidrIpv6).filter((c): c is string => Boolean(c)),
      }))
    );

    const sg: SgSnapshot = { groupIds: params.groupIds, expectedGroupIdAttached, rules };

    const input: PostureInputs = {
      wireguardPort: readWireguardPort(),
      adminAllowedCidr: process.env.AWS_ADMIN_ALLOWED_CIDR?.trim() || undefined,
      wireguardAllowedCidrs: parseCidrList(process.env.AWS_WIREGUARD_ALLOWED_CIDRS),
      expectedGroupConfigured,
      hasStablePublicIp: (addressResult.Addresses ?? []).length > 0,
      sg,
    };

    return classifySecurityPosture(input);
  } catch (error) {
    console.error("Failed to retrieve AWS security posture:", error);
    return {
      state: "unable_to_verify",
      findings: ["Could not verify security posture: unable to read security group or address information."],
    };
  }
}

function parseNetworkResourceId(id: string): { resourceGroup: string; name: string } | null {
  const match = id.match(/\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/[^/]+\/([^/]+)$/i);
  if (!match) return null;
  return { resourceGroup: match[1], name: match[2] };
}

function parseSubnetResourceId(
  id: string
): { resourceGroup: string; vnetName: string; subnetName: string } | null {
  const match = id.match(
    /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/virtualNetworks\/([^/]+)\/subnets\/([^/]+)$/i
  );
  if (!match) return null;
  return { resourceGroup: match[1], vnetName: match[2], subnetName: match[3] };
}

function mapNsgProtocol(protocol: string | undefined): string {
  if (protocol === "Tcp") return "tcp";
  if (protocol === "Udp") return "udp";
  if (protocol === "*") return "-1";
  return (protocol ?? "-1").toLowerCase();
}

function mapNsgSourcePrefix(prefix: string): string {
  return prefix === "*" || prefix === "Internet" ? "0.0.0.0/0" : prefix;
}

function parseNsgPortRange(range: string): { fromPort: number; toPort: number } {
  if (range === "*") return { fromPort: 0, toPort: 65535 };
  const [from, to] = range.split("-");
  const fromPort = Number.parseInt(from, 10);
  const toPort = to !== undefined ? Number.parseInt(to, 10) : fromPort;
  return { fromPort, toPort };
}

/**
 * Pure translation of Azure NSG rules into the same AwsSgRule shape so classifySecurityPosture
 * can be reused as-is for Azure — no separate classifier needed.
 */
export function mapNsgRulesToSgRules(rules: SecurityRule[]): AwsSgRule[] {
  const result: AwsSgRule[] = [];

  for (const rule of rules) {
    if (rule.direction !== "Inbound" || rule.access !== "Allow") continue;

    const protocol = mapNsgProtocol(rule.protocol);
    const rawPrefixes = rule.sourceAddressPrefixes?.length
      ? rule.sourceAddressPrefixes
      : rule.sourceAddressPrefix
        ? [rule.sourceAddressPrefix]
        : [];
    const mappedPrefixes = rawPrefixes.map(mapNsgSourcePrefix);
    const cidrs = mappedPrefixes.filter((p) => !p.includes(":"));
    const ipv6Cidrs = mappedPrefixes.filter((p) => p.includes(":"));

    const portRanges = rule.destinationPortRanges?.length
      ? rule.destinationPortRanges
      : [rule.destinationPortRange ?? "*"];

    for (const range of portRanges) {
      const { fromPort, toPort } = parseNsgPortRange(range);
      result.push({ protocol, fromPort, toPort, cidrs, ipv6Cidrs });
    }
  }

  return result;
}

async function resolveAzureNsgSnapshot(
  client: NetworkManagementClient,
  params: { nicNsgId?: string; subnetId?: string }
): Promise<{ sg: SgSnapshot; expectedGroupConfigured: boolean } | null> {
  let nsgRef = params.nicNsgId ? parseNetworkResourceId(params.nicNsgId) : null;
  if (!nsgRef && params.subnetId) {
    const subnetRef = parseSubnetResourceId(params.subnetId);
    if (subnetRef) {
      const subnet = await client.subnets.get(subnetRef.resourceGroup, subnetRef.vnetName, subnetRef.subnetName);
      nsgRef = subnet.networkSecurityGroup?.id ? parseNetworkResourceId(subnet.networkSecurityGroup.id) : null;
    }
  }
  if (!nsgRef) return null;

  const nsg = await client.networkSecurityGroups.get(nsgRef.resourceGroup, nsgRef.name);
  const expectedNsgName = process.env.AZURE_EXPECTED_NSG_NAME?.trim();
  const expectedGroupConfigured = Boolean(expectedNsgName);
  const expectedGroupIdAttached = expectedGroupConfigured ? nsg.name === expectedNsgName : true;

  return {
    expectedGroupConfigured,
    sg: {
      groupIds: [nsg.name ?? nsgRef.name],
      expectedGroupIdAttached,
      rules: mapNsgRulesToSgRules(nsg.securityRules ?? []),
    },
  };
}

async function resolveAzurePublicIpIsStatic(
  client: NetworkManagementClient,
  publicIpId: string | undefined
): Promise<boolean> {
  if (!publicIpId) return false;
  const ref = parseNetworkResourceId(publicIpId);
  if (!ref) return false;
  try {
    const publicIp = await client.publicIPAddresses.get(ref.resourceGroup, ref.name);
    return publicIp.publicIPAllocationMethod === "Static";
  } catch (error) {
    console.error("Failed to read Azure public IP allocation method:", error);
    return false;
  }
}

export async function getAzureSecurityPosture(params: {
  subscriptionId: string;
  resourceGroup: string;
  nicNsgId?: string;
  subnetId?: string;
  publicIpId?: string;
}): Promise<SecurityPosture> {
  try {
    const credential = new DefaultAzureCredential();
    const client = new NetworkManagementClient(credential, params.subscriptionId);

    // NSG resolution and the public-IP stability check are independent of each other —
    // resolve them concurrently instead of one after another.
    const [nsgResult, hasStablePublicIp] = await Promise.all([
      resolveAzureNsgSnapshot(client, params),
      resolveAzurePublicIpIsStatic(client, params.publicIpId),
    ]);

    if (!nsgResult) {
      return {
        state: "unable_to_verify",
        findings: ["Could not determine the Network Security Group attached to this VM's network interface."],
      };
    }

    const input: PostureInputs = {
      wireguardPort: readWireguardPort(),
      adminAllowedCidr: process.env.AZURE_ADMIN_ALLOWED_CIDR?.trim() || undefined,
      wireguardAllowedCidrs: parseCidrList(process.env.AZURE_WIREGUARD_ALLOWED_CIDRS),
      expectedGroupConfigured: nsgResult.expectedGroupConfigured,
      hasStablePublicIp,
      sg: nsgResult.sg,
    };

    return classifySecurityPosture(input);
  } catch (error) {
    console.error("Failed to retrieve Azure security posture:", error);
    return {
      state: "unable_to_verify",
      findings: ["Could not verify security posture: unable to read NSG or network interface information."],
    };
  }
}
