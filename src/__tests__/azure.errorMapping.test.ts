import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockBeginStartAndWait = vi.fn();
const mockBeginDeallocateAndWait = vi.fn();

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function DefaultAzureCredentialMock() {
    return {};
  }),
}));

vi.mock("@azure/arm-compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/arm-compute")>();
  return {
    ...actual,
    ComputeManagementClient: vi.fn().mockImplementation(function ComputeManagementClientMock() {
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

import { getAzureMachineStatus, startAzureMachine, stopAzureMachine } from "@/cloud/azure";

function makeError(overrides: { name?: string; statusCode?: number; code?: string }, message = "raw internal detail"): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
  if (overrides.name) err.name = overrides.name;
  if (overrides.statusCode !== undefined) err.statusCode = overrides.statusCode;
  if (overrides.code) err.code = overrides.code;
  return err;
}

describe("Azure SDK error mapping (mocked, no live calls)", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_ENABLED", "true");
    vi.stubEnv("AZURE_SUBSCRIPTION_ID", "sub");
    vi.stubEnv("AZURE_RESOURCE_GROUP", "rg");
    vi.stubEnv("AZURE_VM_NAME", "vm");
    mockGet.mockReset();
    mockBeginStartAndWait.mockReset();
    mockBeginDeallocateAndWait.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [{ name: "CredentialUnavailableError" }, /credentials not found or expired/i],
    [{ name: "AuthenticationError" }, /credentials not found or expired/i],
    [{ statusCode: 404 }, /vm was not found/i],
    [{ statusCode: 401 }, /lack permission/i],
    [{ statusCode: 403 }, /lack permission/i],
    [{ statusCode: 429 }, /rate-limiting/i],
    [{ statusCode: 409 }, /already changing state/i],
    [{ code: "OperationNotAllowed" }, /already changing state/i],
  ] as const)("getAzureMachineStatus maps %j to a safe user-facing message", async (overrides, expectedPattern) => {
    mockGet.mockRejectedValueOnce(makeError(overrides));
    const status = await getAzureMachineStatus();
    expect(status.powerState).toBe("unknown");
    expect(status.message).toMatch(expectedPattern);
    expect(status.message).not.toMatch(/raw internal detail/i);
    expect(status.message).not.toContain("Error:");
  });

  it("maps an unrecognized error to a generic safe message", async () => {
    mockGet.mockRejectedValueOnce(makeError({ name: "SomeUnexpectedSdkError" }));
    const status = await getAzureMachineStatus();
    expect(status.message).toBe("Unable to reach Azure right now.");
  });

  it("startAzureMachine reports a 409 as a conflict with a clear message", async () => {
    mockBeginStartAndWait.mockRejectedValueOnce(makeError({ statusCode: 409 }));
    const result = await startAzureMachine();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.message).toMatch(/already changing state/i);
  });

  it("stopAzureMachine succeeds when the SDK call resolves", async () => {
    mockBeginDeallocateAndWait.mockResolvedValueOnce(undefined);
    const result = await stopAzureMachine();
    expect(result.ok).toBe(true);
  });

  it("startAzureMachine returns not_configured without calling Azure when the VM name is missing", async () => {
    vi.stubEnv("AZURE_VM_NAME", "");
    const result = await startAzureMachine();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(mockBeginStartAndWait).not.toHaveBeenCalled();
  });
});
