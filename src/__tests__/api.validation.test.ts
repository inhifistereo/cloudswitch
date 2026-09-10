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

/** A same-origin browser POST. Sec-Fetch-Site is what the CSRF guard trusts. */
function postRequest() {
  return new Request("http://localhost/api/machines/x/start", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  });
}

function getRequest(headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return new Request("http://localhost/api/machines", { headers });
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
    const res = await machinesRoute(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.machines).toHaveLength(2);
    expect(body.machines[1].configured).toBe(false);
  });

  it("rejects a cross-site read without disclosing machine details", async () => {
    const res = await machinesRoute(getRequest({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("machines");
    expect(getAllMachineStatuses).not.toHaveBeenCalled();
  });
});

describe("CSRF guard on start/stop", () => {
  beforeEach(() => {
    vi.mocked(startMachine).mockReset();
    vi.mocked(stopMachine).mockReset();
  });

  function crossSitePost(headers: Record<string, string>) {
    return new Request("http://localhost/api/machines/aws/start", { method: "POST", headers });
  }

  it("rejects a cross-site POST and never reaches the cloud SDK", async () => {
    const res = await startRoute(crossSitePost({ "sec-fetch-site": "cross-site" }), {
      params: Promise.resolve({ provider: "aws" }),
    });
    expect(res.status).toBe(403);
    expect(startMachine).not.toHaveBeenCalled();
  });

  it("rejects a forged Origin when Sec-Fetch-Site is absent", async () => {
    const res = await stopRoute(crossSitePost({ origin: "https://evil.example.com" }), {
      params: Promise.resolve({ provider: "aws" }),
    });
    expect(res.status).toBe(403);
    expect(stopMachine).not.toHaveBeenCalled();
  });

  it("rejects a request carrying neither Sec-Fetch-Site nor Origin (e.g. curl)", async () => {
    const res = await startRoute(crossSitePost({}), { params: Promise.resolve({ provider: "aws" }) });
    expect(res.status).toBe(403);
    expect(startMachine).not.toHaveBeenCalled();
  });

  it("accepts a matching Origin when Sec-Fetch-Site is absent", async () => {
    vi.mocked(startMachine).mockResolvedValue({ ok: true, message: "Start request sent." });
    const res = await startRoute(crossSitePost({ origin: "http://localhost" }), {
      params: Promise.resolve({ provider: "aws" }),
    });
    expect(res.status).toBe(200);
    expect(startMachine).toHaveBeenCalledOnce();
  });

  it("rejects a rebound host that is not on the allowlist", async () => {
    const res = await startRoute(
      new Request("http://attacker.example.com/api/machines/aws/start", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", origin: "http://attacker.example.com" },
      }),
      { params: Promise.resolve({ provider: "aws" }) }
    );
    expect(res.status).toBe(403);
    expect(startMachine).not.toHaveBeenCalled();
  });

  // Regression: the guard originally read request.url, which reflects the address the
  // server is bound to rather than the name the client asked for. A DNS-rebound request
  // arrives on 127.0.0.1 carrying a foreign Host header and looks entirely same-origin
  // to the browser, so it passed. Verified against a live server, not just this test.
  it("rejects a foreign Host header even when the URL itself is loopback", async () => {
    const res = await startRoute(
      new Request("http://127.0.0.1:3000/api/machines/aws/start", {
        method: "POST",
        headers: {
          host: "attacker.example.com",
          origin: "http://attacker.example.com",
          "sec-fetch-site": "same-origin",
        },
      }),
      { params: Promise.resolve({ provider: "aws" }) }
    );
    expect(res.status).toBe(403);
    expect(startMachine).not.toHaveBeenCalled();
  });

  it("accepts a loopback Host header on the default allowlist", async () => {
    vi.mocked(startMachine).mockResolvedValue({ ok: true, message: "Start request sent." });
    const res = await startRoute(
      new Request("http://127.0.0.1:3000/api/machines/aws/start", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" },
      }),
      { params: Promise.resolve({ provider: "aws" }) }
    );
    expect(res.status).toBe(200);
  });
});
