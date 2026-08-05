# AWS one-time provisioning guide

CloudSwitch controls a **pre-existing** EC2 instance — it never creates one. This document is the missing piece: the actual AWS CLI commands to stand up the WireGuard VM that CloudSwitch will then manage.

> ⚠️ **Every command below is meant to be reviewed and run by you, in your own terminal.** These create real, billable, persistent AWS resources (an EC2 instance, a Security Group, an Elastic IP, IAM policies/roles). None of this is executed automatically by CloudSwitch or by any AI agent — copy, read, adjust the placeholders, and run each step yourself.

Placeholders like `<VPC_ID>`, `<SG_ID>`, `<INSTANCE_ID>`, `<AMI_ID>` should be replaced with your real values. The region is set to `us-east-2` throughout — change every `--region us-east-2` if you're using a different region.

## 0. Prerequisites

```bash
aws sts get-caller-identity     # confirms you're authenticated
aws ec2 describe-vpcs --query "Vpcs[].[VpcId,IsDefault,CidrBlock]" --output table
```

Using the default VPC is simplest if you don't already have a specific network layout in mind. This guide uses `us-east-2` throughout — substitute your own region if different, and note it, since you'll need it again in `.env.local` as `AWS_REGION`.

## 1. Create a dedicated Security Group

Never use the default Security Group. Create one specifically for this instance:

```bash
aws ec2 create-security-group \
  --region us-east-2 \
  --group-name cloudswitch-wireguard \
  --description "CloudSwitch WireGuard VM" \
  --vpc-id <VPC_ID>
# note the returned GroupId as <SG_ID>
```

Authorize exactly the rules a WireGuard VPN server needs:

```bash
# WireGuard — UDP, not TCP. 0.0.0.0/0 is normal for roaming clients.
aws ec2 authorize-security-group-ingress \
  --region us-east-2 --group-id <SG_ID> \
  --protocol udp --port 51820 --cidr 0.0.0.0/0

# SSH — only if you plan to use it at all, and only from YOUR admin IP.
# Never use 0.0.0.0/0 here. Prefer skipping this entirely and using SSM
# Session Manager instead (see step 4).
aws ec2 authorize-security-group-ingress \
  --region us-east-2 --group-id <SG_ID> \
  --protocol tcp --port 22 --cidr 203.0.113.10/32
```

Do not add HTTP/HTTPS/ICMP/RDP/database rules — they're not part of this app's scope.

## 2. Find the latest Ubuntu AMI for your region

AMI IDs are region-specific, so resolve the current one via AWS's public SSM parameter rather than hardcoding an ID:

```bash
aws ssm get-parameters --region us-east-2 \
  --names /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id \
  --query 'Parameters[0].Value' --output text
# note the returned value as <AMI_ID>
```

## 3. (Optional but recommended) An instance role for SSM Session Manager

This is a **different** IAM role from the one CloudSwitch itself uses (step 6) — this one is attached to the *instance*, so AWS Systems Manager can give you a shell without any public SSH port at all.

```bash
cat > /tmp/ec2-trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name CloudSwitchWireGuardInstanceRole \
  --assume-role-policy-document file:///tmp/ec2-trust-policy.json

aws iam attach-role-policy \
  --role-name CloudSwitchWireGuardInstanceRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam create-instance-profile --instance-profile-name CloudSwitchWireGuardInstanceProfile

aws iam add-role-to-instance-profile \
  --instance-profile-name CloudSwitchWireGuardInstanceProfile \
  --role-name CloudSwitchWireGuardInstanceRole
```

If you use this, you can skip the SSH Security Group rule in step 1 entirely — connect instead with:

```bash
aws ssm start-session --region us-east-2 --target <INSTANCE_ID>
```

## 4. Launch the instance

```bash
aws ec2 run-instances \
  --region us-east-2 \
  --image-id <AMI_ID> \
  --instance-type t3.micro \
  --security-group-ids <SG_ID> \
  --iam-instance-profile Name=CloudSwitchWireGuardInstanceProfile \
  --count 1 \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=cloudswitch-wireguard}]'
# note the returned InstanceId as <INSTANCE_ID> — this becomes AWS_INSTANCE_ID
```

Drop the `--iam-instance-profile` flag if you skipped step 3.

## 5. Allocate and associate a stable Elastic IP

Without this, the instance's public IP can change every time you stop/start it via CloudSwitch, breaking every WireGuard client's config.

```bash
aws ec2 allocate-address --region us-east-2 --domain vpc
# note the returned AllocationId as <ALLOCATION_ID>

aws ec2 associate-address \
  --region us-east-2 \
  --instance-id <INSTANCE_ID> \
  --allocation-id <ALLOCATION_ID>
```

## 6. IAM policy for CloudSwitch itself

This is the identity your local `aws sso login` (or configured profile) resolves to — distinct from the instance's own SSM role in step 3. See the [README's Minimum IAM permissions section](./README.md#minimum-iam-permissions) for the policy JSON (fill in your account ID and the instance ARN from step 4).

```bash
aws iam create-policy \
  --policy-name CloudSwitchEc2Control \
  --policy-document file://cloudswitch-policy.json
```

Then attach it to whichever principal you use:

```bash
# plain IAM user or role:
aws iam attach-user-policy --user-name <YOUR_IAM_USER> --policy-arn <POLICY_ARN>
# or
aws iam attach-role-policy --role-name <YOUR_IAM_ROLE> --policy-arn <POLICY_ARN>
```

If you're using **IAM Identity Center (SSO)**, attaching to a permission set is usually easier via the console (it needs your SSO instance ARN and identity-store ID looked up first). The CLI equivalent, if you prefer it:

```bash
aws sso-admin put-inline-policy-to-permission-set \
  --instance-arn <SSO_INSTANCE_ARN> \
  --permission-set-arn <PERMISSION_SET_ARN> \
  --inline-policy file://cloudswitch-policy.json
```

## 7. Verify, read-only, before pointing CloudSwitch at it

```bash
aws ec2 describe-instances --region us-east-2 --instance-ids <INSTANCE_ID>
aws ec2 describe-security-groups --region us-east-2 --group-ids <SG_ID>
```

Confirm the instance state, Security Group rules, and associated Elastic IP all look right. Then fill in `.env.local`:

```env
AWS_REGION=us-east-2
AWS_INSTANCE_ID=<INSTANCE_ID>
AWS_EXPECTED_SECURITY_GROUP_ID=<SG_ID>
AWS_ADMIN_ALLOWED_CIDR=203.0.113.10/32
```

## Next steps

- Install and configure WireGuard on the instance itself (outside CloudSwitch's scope).
- Review `scripts/host-firewall-example.sh` for the OS-level firewall (`ufw`) configuration — read it fully before running it.
- Start CloudSwitch with `npm run dev` and confirm the AWS card shows real status.
