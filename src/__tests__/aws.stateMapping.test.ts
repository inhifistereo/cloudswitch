import { describe, expect, it } from "vitest";
import { mapEc2State } from "@/cloud/aws";

describe("mapEc2State", () => {
  it.each([
    ["pending", "pending"],
    ["running", "running"],
    ["shutting-down", "stopping"],
    ["stopping", "stopping"],
    ["stopped", "stopped"],
    ["terminated", "unavailable"],
    ["some-future-aws-state", "unknown"],
    [undefined, "unknown"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(mapEc2State(input)).toBe(expected);
  });
});
