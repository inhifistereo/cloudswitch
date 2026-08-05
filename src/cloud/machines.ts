import type { CloudProvider, MachineStatus, OperationResult } from "@/types";
import { getAwsMachineStatus, startAwsMachine, stopAwsMachine } from "@/cloud/aws";
import { getAzureMachineStatus, startAzureMachine, stopAzureMachine } from "@/cloud/azure";

function fallbackStatus(provider: CloudProvider, reason: unknown): MachineStatus {
  console.error(`Unexpected error retrieving ${provider} status:`, reason);
  return {
    provider,
    name: provider === "aws" ? "AWS VM" : "Azure VM",
    resourceId: "",
    powerState: "unknown",
    configured: false,
    message: "Unexpected error retrieving status.",
    securityPosture: { state: "unable_to_verify", findings: ["Status retrieval failed unexpectedly."] },
  };
}

export async function getAllMachineStatuses(): Promise<MachineStatus[]> {
  const [aws, azure] = await Promise.allSettled([getAwsMachineStatus(), getAzureMachineStatus()]);
  return [
    aws.status === "fulfilled" ? aws.value : fallbackStatus("aws", aws.reason),
    azure.status === "fulfilled" ? azure.value : fallbackStatus("azure", azure.reason),
  ];
}

export async function startMachine(provider: CloudProvider): Promise<OperationResult> {
  if (provider === "aws") return startAwsMachine();
  return startAzureMachine();
}

export async function stopMachine(provider: CloudProvider): Promise<OperationResult> {
  if (provider === "aws") return stopAwsMachine();
  return stopAzureMachine();
}

export function statusCodeFor(result: OperationResult): number {
  if (result.ok) return 200;
  if (result.code === "not_configured" || result.code === "conflict") return 409;
  return 502;
}
