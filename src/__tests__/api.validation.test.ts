import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/cloud/machines", () => ({
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  getAllMachineStatuses: vi.fn(),
  statusCodeFor: (result: { ok: boolean; code?: string }) => {
    if (result.ok) return 200;
    if (result.code === "not_configured" || result.code === "conflict") return 409;
    return 502;
  },
}));

import { POST as startRoute } from "@/app/api/machines/[provider]/start/route";
import { POST as stopRoute } from "@/app/api/machines/[provider]/stop/route";
import { GET as machinesRoute } from "@/app/api/machines/route";
import { startMachine, stopMachine, getAllMachineStatuses } from "@/cloud/machines";

function postRequest() {
  return new Request("http://localhost/api/machines/x/start", { method: "POST" });
}

describe("start/stop route validation", () => {
  beforeEach(() => {
    vi.mocked(startMachine).mockReset();
    vi.mocked(stopMachine).mockReset();
  });

  it("rejects an unknown provider with 400 and never dispatches to machines.ts", async () => {
    const res = await startRoute(postRequest(), { params: Promise.resolve({ provider: "gcp" }) });
    expect(res.status).toBe(400);
    expect(startMachine).not.toHaveBeenCalled();
  });

  it("returns 200 for a successful start", async () => {
    vi.mocked(startMachine).mockResolvedValue({ ok: true, message: "Start request sent." });
    const res = await startRoute(postRequest(), { params: Promise.resolve({ provider: "aws" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("returns 409 when stop reports not_configured", async () => {
    vi.mocked(stopMachine).mockResolvedValue({
      ok: false,
      message: "Azure VM is not configured (AZURE_ENABLED=false).",
      code: "not_configured",
    });
    const res = await stopRoute(postRequest(), { params: Promise.resolve({ provider: "azure" }) });
    expect(res.status).toBe(409);
  });

  it("returns 409 when start reports a conflict (already transitioning)", async () => {
    vi.mocked(startMachine).mockResolvedValue({
      ok: false,
      message: "The instance is already changing state. Wait a moment and refresh.",
      code: "conflict",
    });
    const res = await startRoute(postRequest(), { params: Promise.resolve({ provider: "aws" }) });
    expect(res.status).toBe(409);
  });

  it("returns 502 for an unexpected failure", async () => {
    vi.mocked(startMachine).mockResolvedValue({ ok: false, message: "Unable to reach AWS right now." });
    const res = await startRoute(postRequest(), { params: Promise.resolve({ provider: "aws" }) });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/machines", () => {
  beforeEach(() => {
    vi.mocked(getAllMachineStatuses).mockReset();
  });

  it("returns both machine records", async () => {
    vi.mocked(getAllMachineStatuses).mockResolvedValue([
      { provider: "aws", name: "AWS VM", resourceId: "i-1", powerState: "stopped", configured: true },
      {
        provider: "azure",
        name: "Azure VM",
        resourceId: "",
        powerState: "unavailable",
        configured: false,
        message: "Azure VM is not configured (AZURE_ENABLED=false).",
      },
    ]);
    const res = await machinesRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.machines).toHaveLength(2);
    expect(body.machines[1].configured).toBe(false);
  });
});
