import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAwsConfig } from "@/cloud/aws";

const mockGet = vi.fn();
const mockBeginStartAndWait = vi.fn();
const mockBeginDeallocateAndWait = vi.fn();
const mockCredentialCtor = vi.fn();
const mockComputeClientCtor = vi.fn();

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredentialMock() {
    mockCredentialCtor();
    return {};
  }),
}));

vi.mock("@azure/arm-compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/arm-compute")>();
  return {
    ...actual,
    ComputeManagementClient: vi.fn().mockImplementation(function ComputeManagementClientMock() {
      mockComputeClientCtor();
      return {
        virtualMachines: {
          get: mockGet,
          beginStartAndWait: mockBeginStartAndWait,
          beginDeallocateAndWait: mockBeginDeallocateAndWait,
        },
      };
    }),
  };
});

import { readAzureConfig, getAzureMachineStatus, startAzureMachine, stopAzureMachine } from "@/cloud/azure";

describe("readAwsConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports missing config when AWS_REGION/AWS_INSTANCE_ID are absent", () => {
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_INSTANCE_ID", "");
    const result = readAwsConfig();
    expect("error" in result).toBe(true);
  });

  it("rejects a malformed instance id", () => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_INSTANCE_ID", "not-an-instance-id");
    const result = readAwsConfig();
    expect("error" in result && result.error).toMatch(/not a valid EC2 instance id/i);
  });

  it("accepts a well-formed config", () => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_INSTANCE_ID", "i-0123456789abcdef0");
    vi.stubEnv("AWS_VM_DISPLAY_NAME", "My VPN");
    const result = readAwsConfig();
    expect(result).toEqual({ region: "us-east-1", instanceId: "i-0123456789abcdef0", displayName: "My VPN" });
  });
});

describe("readAzureConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports disabled when AZURE_ENABLED is unset", () => {
    vi.stubEnv("AZURE_ENABLED", "");
    expect(readAzureConfig()).toEqual({ enabled: false });
  });

  it("reports disabled when AZURE_ENABLED is false", () => {
    vi.stubEnv("AZURE_ENABLED", "false");
    expect(readAzureConfig()).toEqual({ enabled: false });
  });

  it("reports an error when enabled but incomplete", () => {
    vi.stubEnv("AZURE_ENABLED", "true");
    vi.stubEnv("AZURE_SUBSCRIPTION_ID", "");
    vi.stubEnv("AZURE_RESOURCE_GROUP", "rg");
    vi.stubEnv("AZURE_VM_NAME", "vm");
    const result = readAzureConfig();
    expect(result.enabled).toBe(true);
    expect("error" in result && result.error).toMatch(/AZURE_SUBSCRIPTION_ID/);
  });

  it("returns the full config when enabled and complete", () => {
    vi.stubEnv("AZURE_ENABLED", "true");
    vi.stubEnv("AZURE_SUBSCRIPTION_ID", "sub");
    vi.stubEnv("AZURE_RESOURCE_GROUP", "rg");
    vi.stubEnv("AZURE_VM_NAME", "vm");
    vi.stubEnv("AZURE_VM_DISPLAY_NAME", "My Azure VPN");
    const result = readAzureConfig();
    expect(result).toEqual({
      enabled: true,
      subscriptionId: "sub",
      resourceGroup: "rg",
      vmName: "vm",
      displayName: "My Azure VPN",
    });
  });
});

describe("Azure disabled-by-default behavior", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockBeginStartAndWait.mockReset();
    mockBeginDeallocateAndWait.mockReset();
    mockCredentialCtor.mockReset();
    mockComputeClientCtor.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("getAzureMachineStatus is unconfigured/unavailable without ever calling the Azure SDK", async () => {
    vi.stubEnv("AZURE_ENABLED", "false");
    const status = await getAzureMachineStatus();
    expect(status.configured).toBe(false);
    expect(status.powerState).toBe("unavailable");
    expect(status.securityPosture).toBeUndefined();
    expect(mockComputeClientCtor).not.toHaveBeenCalled();
  });

  it("start/stop report not_configured without calling the Azure SDK when disabled", async () => {
    vi.stubEnv("AZURE_ENABLED", "true");
    vi.stubEnv("AZURE_SUBSCRIPTION_ID", "");
    vi.stubEnv("AZURE_RESOURCE_GROUP", "rg");
    vi.stubEnv("AZURE_VM_NAME", "vm");

    const startResult = await startAzureMachine();
    expect(startResult.ok).toBe(false);
    expect(startResult.code).toBe("not_configured");
    const stopResult = await stopAzureMachine();
    expect(stopResult.ok).toBe(false);
    expect(stopResult.code).toBe("not_configured");
    expect(mockComputeClientCtor).not.toHaveBeenCalled();
  });
});

describe("Azure real control (mocked SDK, no live calls)", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_ENABLED", "true");
    vi.stubEnv("AZURE_SUBSCRIPTION_ID", "sub");
    vi.stubEnv("AZURE_RESOURCE_GROUP", "rg");
    vi.stubEnv("AZURE_VM_NAME", "vm");
    mockGet.mockReset();
    mockBeginStartAndWait.mockReset();
    mockBeginDeallocateAndWait.mockReset();
    mockCredentialCtor.mockReset();
    mockComputeClientCtor.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("getAzureMachineStatus reports a real power state once fully configured", async () => {
    mockGet.mockResolvedValueOnce({
      instanceView: { statuses: [{ code: "PowerState/running" }] },
    });
    const status = await getAzureMachineStatus();
    expect(status.configured).toBe(true);
    expect(status.powerState).toBe("running");
  });

  it("startAzureMachine succeeds when the SDK call resolves", async () => {
    mockBeginStartAndWait.mockResolvedValueOnce(undefined);
    const result = await startAzureMachine();
    expect(result.ok).toBe(true);
  });

  it("stopAzureMachine calls deallocate (not a plain shutdown) and succeeds", async () => {
    mockBeginDeallocateAndWait.mockResolvedValueOnce(undefined);
    const result = await stopAzureMachine();
    expect(result.ok).toBe(true);
    expect(mockBeginDeallocateAndWait).toHaveBeenCalledWith("rg", "vm");
  });
});
