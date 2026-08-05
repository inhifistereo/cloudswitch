import { describe, expect, it } from "vitest";
import { mapAzurePowerState } from "@/cloud/azure";

describe("mapAzurePowerState", () => {
  it.each([
    [[{ code: "PowerState/running" }], "running"],
    [[{ code: "PowerState/starting" }], "starting"],
    [[{ code: "PowerState/stopping" }], "stopping"],
    [[{ code: "PowerState/deallocating" }], "stopping"],
    [[{ code: "PowerState/stopped" }], "stopped"],
    [[{ code: "PowerState/deallocated" }], "deallocated"],
    [[{ code: "ProvisioningState/succeeded" }, { code: "PowerState/running" }], "running"],
    [[{ code: "PowerState/some-future-state" }], "unknown"],
    [[], "unknown"],
    [undefined, "unknown"],
  ] as const)("maps %j to %s", (statuses, expected) => {
    expect(mapAzurePowerState(statuses as never)).toBe(expected);
  });
});
