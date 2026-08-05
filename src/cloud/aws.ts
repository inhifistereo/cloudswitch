import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { MachinePowerState, MachineStatus, OperationResult } from "@/types";
import { getAwsSecurityPosture, readWireguardPort } from "@/cloud/security";

const INSTANCE_ID_PATTERN = /^i-[a-f0-9]{8,17}$/;

export interface AwsConfig {
  region: string;
  instanceId: string;
  displayName: string;
}

export function readAwsConfig(): AwsConfig | { error: string } {
  const region = process.env.AWS_REGION?.trim();
  const instanceId = process.env.AWS_INSTANCE_ID?.trim();
  const displayName = process.env.AWS_VM_DISPLAY_NAME?.trim() || "AWS VM";

  if (!region || !instanceId) {
    return { error: "AWS VM is not configured. Set AWS_REGION and AWS_INSTANCE_ID." };
  }
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    return { error: "AWS_INSTANCE_ID is not a valid EC2 instance id." };
  }
  return { region, instanceId, displayName };
}

export function mapEc2State(awsState: string | undefined): MachinePowerState {
  switch (awsState) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "shutting-down":
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "terminated":
      return "unavailable";
    default:
      return "unknown";
  }
}

function getErrorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name: unknown }).name);
  }
  return "Unknown";
}

function mapAwsError(error: unknown): string {
  const name = getErrorName(error);
  console.error(`AWS EC2 operation failed (${name}):`, error);

  if (
    name === "CredentialsProviderError" ||
    name === "UnrecognizedClientException" ||
    name === "ExpiredTokenException" ||
    name === "AuthFailure"
  ) {
    return "AWS credentials not found or expired. Run `aws sso login` (or refresh your credentials) and try again.";
  }
  if (name === "InvalidInstanceID.NotFound") {
    return "Configured EC2 instance was not found in this region. Check AWS_REGION and AWS_INSTANCE_ID.";
  }
  if (name === "UnauthorizedOperation" || name === "AccessDenied" || name === "AccessDeniedException") {
    return "AWS credentials lack permission for this action. Check the attached IAM policy.";
  }
  if (name === "RequestLimitExceeded" || name === "Throttling" || name === "ThrottlingException") {
    return "AWS is rate-limiting requests right now. Try again shortly.";
  }
  if (name === "IncorrectInstanceState") {
    return "The instance is already changing state. Wait a moment and refresh.";
  }
  return "Unable to reach AWS right now.";
}

function isConflict(error: unknown): boolean {
  return getErrorName(error) === "IncorrectInstanceState";
}

export async function getAwsMachineStatus(): Promise<MachineStatus> {
  const wireguardPort = readWireguardPort();
  const config = readAwsConfig();

  if ("error" in config) {
    return {
      provider: "aws",
      name: process.env.AWS_VM_DISPLAY_NAME?.trim() || "AWS VM",
      resourceId: process.env.AWS_INSTANCE_ID?.trim() ?? "",
      powerState: "unavailable",
      configured: false,
      message: config.error,
      wireguardPort,
    };
  }

  try {
    const client = new EC2Client({ region: config.region });
    const result = await client.send(new DescribeInstancesCommand({ InstanceIds: [config.instanceId] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];

    if (!instance) {
      return {
        provider: "aws",
        name: config.displayName,
        resourceId: config.instanceId,
        powerState: "unavailable",
        configured: true,
        message: "Configured EC2 instance was not found in this region. Check AWS_REGION and AWS_INSTANCE_ID.",
        wireguardPort,
      };
    }

    const powerState = mapEc2State(instance.State?.Name);
    const publicAddress = instance.PublicIpAddress ?? instance.PublicDnsName ?? undefined;
    const groupIds = (instance.SecurityGroups ?? [])
      .map((g) => g.GroupId)
      .filter((id): id is string => Boolean(id));

    const securityPosture = await getAwsSecurityPosture({
      instanceId: config.instanceId,
      region: config.region,
      groupIds,
    });

    return {
      provider: "aws",
      name: config.displayName,
      resourceId: config.instanceId,
      powerState,
      configured: true,
      publicAddress,
      wireguardPort,
      securityPosture,
    };
  } catch (error) {
    return {
      provider: "aws",
      name: config.displayName,
      resourceId: config.instanceId,
      powerState: "unknown",
      configured: true,
      message: mapAwsError(error),
      wireguardPort,
    };
  }
}

export async function startAwsMachine(): Promise<OperationResult> {
  const config = readAwsConfig();
  if ("error" in config) return { ok: false, message: config.error, code: "not_configured" };

  try {
    const client = new EC2Client({ region: config.region });
    await client.send(new StartInstancesCommand({ InstanceIds: [config.instanceId] }));
    return { ok: true, message: "Start request sent." };
  } catch (error) {
    return { ok: false, message: mapAwsError(error), code: isConflict(error) ? "conflict" : undefined };
  }
}

export async function stopAwsMachine(): Promise<OperationResult> {
  const config = readAwsConfig();
  if ("error" in config) return { ok: false, message: config.error, code: "not_configured" };

  try {
    const client = new EC2Client({ region: config.region });
    await client.send(new StopInstancesCommand({ InstanceIds: [config.instanceId] }));
    return { ok: true, message: "Stop request sent." };
  } catch (error) {
    return { ok: false, message: mapAwsError(error), code: isConflict(error) ? "conflict" : undefined };
  }
}
