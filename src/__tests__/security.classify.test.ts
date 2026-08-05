import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySecurityPosture,
  mapNsgRulesToSgRules,
  parseCidrList,
  readWireguardPort,
  type PostureInputs,
} from "@/cloud/security";
import type { SecurityRule } from "@azure/arm-network";

const ALL_STATES = ["expected", "restricted", "warning", "unable_to_verify"];

function baseInput(overrides: Partial<PostureInputs> = {}): PostureInputs {
  return {
    wireguardPort: 51820,
    adminAllowedCidr: "203.0.113.10/32",
    wireguardAllowedCidrs: ["0.0.0.0/0"],
    expectedGroupConfigured: true,
    hasStablePublicIp: true,
    sg: {
      groupIds: ["sg-123"],
      expectedGroupIdAttached: true,
      rules: [
        { protocol: "udp", fromPort: 51820, toPort: 51820, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["203.0.113.10/32"], ipv6Cidrs: [] },
      ],
    },
    ...overrides,
  };
}

describe("classifySecurityPosture", () => {
  it("returns unable_to_verify when the SG snapshot is null", () => {
    const result = classifySecurityPosture(baseInput({ sg: null }));
    expect(result.state).toBe("unable_to_verify");
  });

  it("returns expected for a clean, fully-matching configuration", () => {
    const result = classifySecurityPosture(baseInput());
    expect(result.state).toBe("expected");
    expect(result.findings.some((f) => /expected for roaming VPN clients/i.test(f))).toBe(true);
    expect(result.findings.some((f) => /restricted to the configured admin CIDR/i.test(f))).toBe(true);
  });

  it("flags WireGuard configured as TCP instead of UDP as a warning", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [{ protocol: "tcp", fromPort: 51820, toPort: 51820, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] }],
        },
      })
    );
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /not UDP/i.test(f))).toBe(true);
  });

  it("flags SSH open to the entire internet as a warning", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [
            { protocol: "udp", fromPort: 51820, toPort: 51820, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
            { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
          ],
        },
      })
    );
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /SSH \(22\) is open to the entire internet/i.test(f))).toBe(true);
  });

  it("flags RDP open to the internet as a warning", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [
            { protocol: "udp", fromPort: 51820, toPort: 51820, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
            { protocol: "tcp", fromPort: 3389, toPort: 3389, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] },
          ],
        },
      })
    );
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /RDP \(3389\)/i.test(f))).toBe(true);
  });

  it("flags an all-protocols/all-ports rule once, without a duplicate 'unexpected port' finding", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [{ protocol: "-1", cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] }],
        },
      })
    );
    expect(result.state).toBe("warning");
    const allPortsFindings = result.findings.filter((f) => /all ports\/protocols/i.test(f));
    expect(allPortsFindings).toHaveLength(1);
    expect(result.findings.some((f) => /unexpected port/i.test(f))).toBe(false);
  });

  it("flags a missing WireGuard inbound rule as a warning", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["203.0.113.10/32"], ipv6Cidrs: [] }],
        },
      })
    );
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /no inbound rule found for wireguard/i.test(f))).toBe(true);
  });

  it("flags the expected security group not being attached", () => {
    const result = classifySecurityPosture(
      baseInput({ sg: { groupIds: ["sg-other"], expectedGroupIdAttached: false, rules: baseInput().sg!.rules } })
    );
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /expected security group is not attached/i.test(f))).toBe(true);
  });

  it("flags a missing stable public IP", () => {
    const result = classifySecurityPosture(baseInput({ hasStablePublicIp: false }));
    expect(result.state).toBe("warning");
    expect(result.findings.some((f) => /no elastic ip/i.test(f))).toBe(true);
  });

  it("flags a WireGuard rule scoped to an unexpected CIDR as restricted, not a warning", () => {
    const result = classifySecurityPosture(
      baseInput({
        sg: {
          groupIds: ["sg-123"],
          expectedGroupIdAttached: true,
          rules: [
            { protocol: "udp", fromPort: 51820, toPort: 51820, cidrs: ["203.0.113.5/32"], ipv6Cidrs: [] },
            { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["203.0.113.10/32"], ipv6Cidrs: [] },
          ],
        },
      })
    );
    expect(result.state).toBe("restricted");
    expect(result.findings.some((f) => /unexpected range/i.test(f))).toBe(true);
  });

  it("never returns a state outside the four defined literals", () => {
    const scenarios: PostureInputs[] = [
      baseInput(),
      baseInput({ sg: null }),
      baseInput({ hasStablePublicIp: false }),
    ];
    for (const scenario of scenarios) {
      expect(ALL_STATES).toContain(classifySecurityPosture(scenario).state);
    }
  });
});

describe("parseCidrList", () => {
  it("splits, trims, and drops empty entries", () => {
    expect(parseCidrList(" 10.0.0.0/8 , 192.168.1.1/32,,")).toEqual(["10.0.0.0/8", "192.168.1.1/32"]);
  });

  it("returns an empty array for undefined or blank input", () => {
    expect(parseCidrList(undefined)).toEqual([]);
    expect(parseCidrList("")).toEqual([]);
  });
});

describe("mapNsgRulesToSgRules", () => {
  function nsgRule(overrides: Partial<SecurityRule> = {}): SecurityRule {
    return {
      protocol: "Udp",
      destinationPortRange: "51820",
      sourceAddressPrefix: "*",
      access: "Allow",
      direction: "Inbound",
      priority: 100,
      ...overrides,
    } as SecurityRule;
  }

  it("maps protocol, port, and '*' source to the AwsSgRule shape", () => {
    const result = mapNsgRulesToSgRules([nsgRule()]);
    expect(result).toEqual([{ protocol: "udp", fromPort: 51820, toPort: 51820, cidrs: ["0.0.0.0/0"], ipv6Cidrs: [] }]);
  });

  it("maps the 'Internet' tag the same as '*'", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ sourceAddressPrefix: "Internet" })]);
    expect(result[0].cidrs).toEqual(["0.0.0.0/0"]);
  });

  it("passes through a real CIDR unchanged", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ sourceAddressPrefix: "203.0.113.10/32" })]);
    expect(result[0].cidrs).toEqual(["203.0.113.10/32"]);
  });

  it("maps the '*' protocol to -1 (all protocols)", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ protocol: "*" })]);
    expect(result[0].protocol).toBe("-1");
  });

  it("expands a '*' port range to 0-65535", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ destinationPortRange: "*" })]);
    expect(result[0]).toMatchObject({ fromPort: 0, toPort: 65535 });
  });

  it("parses a port range like '1000-2000'", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ destinationPortRange: "1000-2000" })]);
    expect(result[0]).toMatchObject({ fromPort: 1000, toPort: 2000 });
  });

  it("expands destinationPortRanges into one rule per range", () => {
    const result = mapNsgRulesToSgRules([nsgRule({ destinationPortRange: undefined, destinationPortRanges: ["22", "51820"] })]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.fromPort)).toEqual([22, 51820]);
  });

  it("uses sourceAddressPrefixes (plural) when present", () => {
    const result = mapNsgRulesToSgRules([
      nsgRule({ sourceAddressPrefix: undefined, sourceAddressPrefixes: ["10.0.0.0/8", "192.168.1.1/32"] }),
    ]);
    expect(result[0].cidrs).toEqual(["10.0.0.0/8", "192.168.1.1/32"]);
  });

  it("filters out Deny and Outbound rules", () => {
    const result = mapNsgRulesToSgRules([
      nsgRule({ access: "Deny" }),
      nsgRule({ direction: "Outbound" }),
    ]);
    expect(result).toHaveLength(0);
  });
});

describe("readWireguardPort", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 51820 when unset", () => {
    vi.stubEnv("WIREGUARD_PORT", "");
    expect(readWireguardPort()).toBe(51820);
  });

  it("parses a valid configured port", () => {
    vi.stubEnv("WIREGUARD_PORT", "51821");
    expect(readWireguardPort()).toBe(51821);
  });

  it("falls back to 51820 for an out-of-range or invalid value", () => {
    vi.stubEnv("WIREGUARD_PORT", "70000");
    expect(readWireguardPort()).toBe(51820);
    vi.stubEnv("WIREGUARD_PORT", "not-a-number");
    expect(readWireguardPort()).toBe(51820);
  });
});
