export type CloudProvider = "aws" | "azure";

export type MachinePowerState =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "pending"
  | "deallocated"
  | "unknown"
  | "unavailable";

export type SecurityPostureState =
  | "expected"
  | "restricted"
  | "warning"
  | "unable_to_verify";

export interface SecurityPosture {
  state: SecurityPostureState;
  findings: string[];
}

export interface MachineStatus {
  provider: CloudProvider;
  name: string;
  resourceId: string;
  powerState: MachinePowerState;
  configured: boolean;
  message?: string;
  publicAddress?: string;
  wireguardPort?: number;
  securityPosture?: SecurityPosture;
}

export interface OperationResult {
  ok: boolean;
  message: string;
  code?: "not_configured" | "conflict";
}

export function isCloudProvider(value: string): value is CloudProvider {
  return value === "aws" || value === "azure";
}
