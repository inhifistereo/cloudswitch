import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient, type InstanceViewStatus } from "@azure/arm-compute";
import { NetworkManagementClient } from "@azure/arm-network";
import type { MachinePowerState, MachineStatus, OperationResult } from "@/types";
import { getAzureSecurityPosture, readWireguardPort } from "@/cloud/security";

export type AzureConfig =
  | { enabled: false }
  | { enabled: true; subscriptionId: string; resourceGroup: string; vmName: string; displayName: string }
  | { enabled: true; error: string };

export function readAzureConfig(): AzureConfig {
  const enabled = process.env.AZURE_ENABLED?.trim().toLowerCase() === "true";
  if (!enabled) return { enabled: false };

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID?.trim();
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP?.trim();
  const vmName = process.env.AZURE_VM_NAME?.trim();
  const displayName = process.env.AZURE_VM_DISPLAY_NAME?.trim() || "Azure VM";

  if (!subscriptionId || !resourceGroup || !vmName) {
    return {
      enabled: true,
      error: "Azure is enabled but AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, or AZURE_VM_NAME is missing.",
    };
  }
  return { enabled: true, subscriptionId, resourceGroup, vmName, displayName };
}

export function mapAzurePowerState(statuses: InstanceViewStatus[] | undefined): MachinePowerState {
  const code = statuses?.find((s) => s.code?.startsWith("PowerState/"))?.code;
  switch (code) {
    case "PowerState/running":
      return "running";
    case "PowerState/starting":
      return "starting";
    case "PowerState/stopping":
    case "PowerState/deallocating":
      return "stopping";
    case "PowerState/stopped":
      return "stopped";
    case "PowerState/deallocated":
      return "deallocated";
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

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    return (error as { statusCode?: number }).statusCode;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function mapAzureError(error: unknown): string {
  const name = getErrorName(error);
  const statusCode = getStatusCode(error);
  console.error(`Azure operation failed (${name}, status ${statusCode}):`, error);

  if (name === "CredentialUnavailableError" || name === "AuthenticationError" || name === "AggregateAuthenticationError") {
    return "Azure credentials not found or expired. Run `az login` (or refresh your service principal credentials) and try again.";
  }
  if (statusCode === 404) {
    return "Configured Azure VM was not found. Check AZURE_RESOURCE_GROUP and AZURE_VM_NAME.";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "Azure credentials lack permission for this action. Check the assigned role.";
  }
  if (statusCode === 429) {
    return "Azure is rate-limiting requests right now. Try again shortly.";
  }
  if (statusCode === 409 || getErrorCode(error) === "OperationNotAllowed") {
    return "The VM is already changing state. Wait a moment and refresh.";
  }
  return "Unable to reach Azure right now.";
}

function isAzureConflict(error: unknown): boolean {
  return getStatusCode(error) === 409 || getErrorCode(error) === "OperationNotAllowed";
}

function parseNetworkResourceId(id: string): { resourceGroup: string; name: string } | null {
  const match = id.match(/\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/[^/]+\/([^/]+)$/i);
  if (!match) return null;
  return { resourceGroup: match[1], name: match[2] };
}

async function resolvePublicAddress(
  credential: DefaultAzureCredential,
  subscriptionId: string,
  publicIpId: string | undefined
): Promise<string | undefined> {
  if (!publicIpId) return undefined;
  const ref = parseNetworkResourceId(publicIpId);
  if (!ref) return undefined;
  try {
    const networkClient = new NetworkManagementClient(credential, subscriptionId);
    const publicIp = await networkClient.publicIPAddresses.get(ref.resourceGroup, ref.name);
    return publicIp.ipAddress;
  } catch (error) {
    console.error("Failed to read Azure public IP address:", error);
    return undefined;
  }
}

export async function getAzureMachineStatus(): Promise<MachineStatus> {
  const config = readAzureConfig();
  const wireguardPort = readWireguardPort();
  const displayName = process.env.AZURE_VM_DISPLAY_NAME?.trim() || "Azure VM";
  const resourceId = process.env.AZURE_VM_NAME?.trim() ?? "";

  if (!config.enabled) {
    return {
      provider: "azure",
      name: displayName,
      resourceId,
      powerState: "unavailable",
      configured: false,
      message: "Azure VM is not configured (AZURE_ENABLED=false).",
      wireguardPort,
    };
  }

  if ("error" in config) {
    return {
      provider: "azure",
      name: displayName,
      resourceId,
      powerState: "unavailable",
      configured: false,
      message: config.error,
      wireguardPort,
    };
  }

  try {
    const credential = new DefaultAzureCredential();
    const client = new ComputeManagementClient(credential, config.subscriptionId);
    const vm = await client.virtualMachines.get(config.resourceGroup, config.vmName, { expand: "instanceView" });

    const powerState = mapAzurePowerState(vm.instanceView?.statuses);

    let nicNsgId: string | undefined;
    let subnetId: string | undefined;
    let publicIpId: string | undefined;

    const nicId = vm.networkProfile?.networkInterfaces?.[0]?.id;
    const nicRef = nicId ? parseNetworkResourceId(nicId) : null;

    if (nicRef) {
      try {
        const networkClient = new NetworkManagementClient(credential, config.subscriptionId);
        const nic = await networkClient.networkInterfaces.get(nicRef.resourceGroup, nicRef.name);
        const ipConfig = nic.ipConfigurations?.[0];
        nicNsgId = nic.networkSecurityGroup?.id;
        subnetId = ipConfig?.subnet?.id;
        publicIpId = ipConfig?.publicIPAddress?.id;
      } catch (networkError) {
        console.error("Failed to read Azure network interface:", networkError);
      }
    }

    // The display public IP address and the security-posture check (NSG + public IP stability)
    // are independent once the NIC is known — resolve them concurrently, not one after another.
    const [publicAddress, securityPosture] = await Promise.all([
      resolvePublicAddress(credential, config.subscriptionId, publicIpId),
      getAzureSecurityPosture({
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        nicNsgId,
        subnetId,
        publicIpId,
      }),
    ]);

    return {
      provider: "azure",
      name: config.displayName,
      resourceId: config.vmName,
      powerState,
      configured: true,
      publicAddress,
      wireguardPort,
      securityPosture,
    };
  } catch (error) {
    return {
      provider: "azure",
      name: config.displayName,
      resourceId: config.vmName,
      powerState: "unknown",
      configured: true,
      message: mapAzureError(error),
      wireguardPort,
    };
  }
}

export async function startAzureMachine(): Promise<OperationResult> {
  const config = readAzureConfig();
  if (!config.enabled) {
    return { ok: false, message: "Azure VM is not configured (AZURE_ENABLED=false).", code: "not_configured" };
  }
  if ("error" in config) return { ok: false, message: config.error, code: "not_configured" };

  try {
    const credential = new DefaultAzureCredential();
    const client = new ComputeManagementClient(credential, config.subscriptionId);
    await client.virtualMachines.beginStartAndWait(config.resourceGroup, config.vmName);
    return { ok: true, message: "Start request sent." };
  } catch (error) {
    return { ok: false, message: mapAzureError(error), code: isAzureConflict(error) ? "conflict" : undefined };
  }
}

export async function stopAzureMachine(): Promise<OperationResult> {
  const config = readAzureConfig();
  if (!config.enabled) {
    return { ok: false, message: "Azure VM is not configured (AZURE_ENABLED=false).", code: "not_configured" };
  }
  if ("error" in config) return { ok: false, message: config.error, code: "not_configured" };

  try {
    const credential = new DefaultAzureCredential();
    const client = new ComputeManagementClient(credential, config.subscriptionId);
    // Deallocate, not an OS-level shutdown — this actually releases compute allocation so billing stops.
    await client.virtualMachines.beginDeallocateAndWait(config.resourceGroup, config.vmName);
    return { ok: true, message: "Stop request sent." };
  } catch (error) {
    return { ok: false, message: mapAzureError(error), code: isAzureConflict(error) ? "conflict" : undefined };
  }
}
