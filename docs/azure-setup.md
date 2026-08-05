# Azure one-time credential setup

CloudSwitch controls a **pre-existing** Azure VM — it never creates one. Unlike [AWS_SETUP.md](./AWS_SETUP.md), this guide doesn't provision any infrastructure: it only creates the credentials CloudSwitch itself uses to call the Azure APIs against a VM (and its NSG) you've already set up.

> ⚠️ **Every command below is meant to be reviewed and run by you, in your own terminal.** `az ad sp create-for-rbac` creates a real, persistent Azure AD application and role assignment. None of this is executed automatically by CloudSwitch or by any AI agent — copy, read, adjust the placeholders, and run each step yourself.

Placeholders like `<SUBSCRIPTION_ID>`, `<RESOURCE_GROUP>`, `<VM_NAME>` should be replaced with your real values.

## 0. Prerequisites

```bash
az login
az account show --query "{subscriptionId:id, name:name}" --output table
```

## 1. Find the existing VM's resource group and name

```bash
az vm list --output table
# note the ResourceGroup and Name columns — these become
# AZURE_RESOURCE_GROUP and AZURE_VM_NAME
```

## 2. Create a service principal scoped to just that resource group

Never create a subscription-wide service principal for this. Scope it to the resource group the VM (and its NSG) lives in:

```bash
az ad sp create-for-rbac \
  --name cloudswitch-azure-control \
  --role "Virtual Machine Contributor" \
  --scopes /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RESOURCE_GROUP>
```

The output looks like:

```json
{
  "appId": "...",
  "displayName": "cloudswitch-azure-control",
  "password": "...",
  "tenant": "..."
}
```

Map these directly to `.env.local`:

| Output field | `.env.local` variable |
|---|---|
| `appId` | `AZURE_CLIENT_ID` |
| `password` | `AZURE_CLIENT_SECRET` |
| `tenant` | `AZURE_TENANT_ID` |

The `password` is shown only once — copy it now.

## 3. Add read access for the security-posture check

"Virtual Machine Contributor" covers start/stop/status, but the read-only NSG/network-interface/public-IP checks CloudSwitch runs (to report security posture) need broader read access. Add a second, still resource-group-scoped role assignment:

```bash
az role assignment create \
  --assignee <APP_ID_FROM_STEP_2> \
  --role "Reader" \
  --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RESOURCE_GROUP>
```

No Security Group/NSG-mutating role is ever requested — CloudSwitch only reads NSG configuration to report posture, never changes it.

## 4. Verify, read-only, before pointing CloudSwitch at it

```bash
az vm show --resource-group <RESOURCE_GROUP> --name <VM_NAME> --query "{name:name, provisioningState:provisioningState}"
az network nsg list --resource-group <RESOURCE_GROUP> --output table
```

Note the NSG name for `AZURE_EXPECTED_NSG_NAME`. Then fill in `.env.local`:

```env
AZURE_ENABLED=true
AZURE_SUBSCRIPTION_ID=<SUBSCRIPTION_ID>
AZURE_RESOURCE_GROUP=<RESOURCE_GROUP>
AZURE_VM_NAME=<VM_NAME>
AZURE_CLIENT_ID=<appId from step 2>
AZURE_CLIENT_SECRET=<password from step 2>
AZURE_TENANT_ID=<tenant from step 2>
AZURE_EXPECTED_NSG_NAME=<NSG name from step 4>
AZURE_ADMIN_ALLOWED_CIDR=<your admin IP in /32 notation>
```

## Next steps

- Start CloudSwitch with `npm run dev` and confirm the Azure card shows real status, public address, and security posture.
- Review the [README's Expected Azure NSG posture section](./README.md#wireguard-and-network-security) for what a healthy NSG configuration looks like.
