import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-ec2")>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(function EC2ClientMock() {
      return { send: mockSend };
    }),
  };
});

import { getAwsMachineStatus, startAwsMachine, stopAwsMachine } from "@/cloud/aws";

function makeError(name: string, message = "raw internal detail"): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("AWS SDK error mapping (mocked, no live calls)", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_INSTANCE_ID", "i-0123456789abcdef0");
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["CredentialsProviderError", /credentials not found or expired/i],
    ["UnrecognizedClientException", /credentials not found or expired/i],
    ["ExpiredTokenException", /credentials not found or expired/i],
    ["AuthFailure", /credentials not found or expired/i],
    ["InvalidInstanceID.NotFound", /instance was not found/i],
    ["UnauthorizedOperation", /lack permission/i],
    ["AccessDenied", /lack permission/i],
    ["RequestLimitExceeded", /rate-limiting/i],
  ])("getAwsMachineStatus maps %s to a safe user-facing message", async (errorName, expectedPattern) => {
    mockSend.mockRejectedValueOnce(makeError(errorName));
    const status = await getAwsMachineStatus();
    expect(status.powerState).toBe("unknown");
    expect(status.message).toMatch(expectedPattern);
    expect(status.message).not.toMatch(/raw internal detail/i);
    expect(status.message).not.toContain("Error:");
  });

  it("maps an unrecognized error to a generic safe message", async () => {
    mockSend.mockRejectedValueOnce(makeError("SomeUnexpectedSdkError"));
    const status = await getAwsMachineStatus();
    expect(status.message).toBe("Unable to reach AWS right now.");
  });

  it("startAwsMachine reports IncorrectInstanceState as a conflict with a clear message", async () => {
    mockSend.mockRejectedValueOnce(makeError("IncorrectInstanceState"));
    const result = await startAwsMachine();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.message).toMatch(/already changing state/i);
  });

  it("stopAwsMachine succeeds when the SDK call resolves", async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await stopAwsMachine();
    expect(result.ok).toBe(true);
  });

  it("startAwsMachine returns not_configured without calling AWS when instance id is missing", async () => {
    vi.stubEnv("AWS_INSTANCE_ID", "");
    const result = await startAwsMachine();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(mockSend).not.toHaveBeenCalled();
  });
});
