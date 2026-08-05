##############################################
# Terraform & Provider Configuration
##############################################

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "Terraform"
      Environment = "Personal"
    }
  }
}

##############################################
# Variables
##############################################

variable "aws_region" {
  type        = string
  description = "AWS region for all regional resources."
  default     = "us-west-2"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type for the WireGuard host."
  default     = "t3.micro"
}

variable "ssh_allowed_cidr" {
  type        = string
  description = "CIDR block allowed to reach SSH (port 22). This should normally be the administrator's public IP followed by /32."

  validation {
    condition     = can(cidrhost(var.ssh_allowed_cidr, 0))
    error_message = "ssh_allowed_cidr must be a valid CIDR block, e.g. 203.0.113.10/32."
  }
}

variable "public_key_path" {
  type        = string
  description = "Path to the local SSH public key file used to create the AWS key pair."
  default     = "~/.ssh/id_ed25519.pub"
}

variable "project_name" {
  type        = string
  description = "Project name used for tagging resources."
  default     = "CloudVM"
}

##############################################
# Data Sources
##############################################

# Dynamically select an availability zone available in the region.
data "aws_availability_zones" "available" {
  state = "available"
}

# Latest Ubuntu Server 24.04 LTS (Noble) x86-64 AMI published by Canonical.
data "aws_ami" "ubuntu_2404" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

##############################################
# Networking
##############################################

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/24"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "wireguard-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.0.0/28"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "wireguard-public-subnet"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "wireguard-internet-gateway"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "wireguard-public-route-table"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

##############################################
# Security Group
##############################################

resource "aws_security_group" "wireguard" {
  name        = "wireguard-sg"
  description = "Allow WireGuard and restricted SSH access"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "WireGuard"
    from_port   = 51820
    to_port     = 51820
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH from administrator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "wireguard-sg"
  }
}

##############################################
# SSH Key Pair
##############################################

resource "aws_key_pair" "main" {
  key_name   = "${var.project_name}-key"
  public_key = file(pathexpand(var.public_key_path))
}

##############################################
# EC2 Instance
##############################################

resource "aws_instance" "wireguard" {
  ami                         = data.aws_ami.ubuntu_2404.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.wireguard.id]
  key_name                    = aws_key_pair.main.key_name
  associate_public_ip_address = true

  monitoring    = true
  ebs_optimized = true

  instance_initiated_shutdown_behavior = "stop"

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = "wireguard"
  }
}

##############################################
# Elastic IP
##############################################

resource "aws_eip" "wireguard" {
  domain   = "vpc"
  instance = aws_instance.wireguard.id

  tags = {
    Name = "wireguard-eip"
  }
}

##############################################
# Outputs
##############################################

output "instance_id" {
  description = "ID of the EC2 instance."
  value       = aws_instance.wireguard.id
}

output "elastic_ip" {
  description = "Elastic public IP address associated with the instance."
  value       = aws_eip.wireguard.public_ip
}

output "public_dns" {
  description = "Public DNS name of the EC2 instance."
  value       = aws_instance.wireguard.public_dns
}

output "private_ip" {
  description = "Private IP address of the EC2 instance."
  value       = aws_instance.wireguard.private_ip
}

output "vpc_id" {
  description = "ID of the custom VPC."
  value       = aws_vpc.main.id
}

output "subnet_id" {
  description = "ID of the public subnet."
  value       = aws_subnet.public.id
}

output "security_group_id" {
  description = "ID of the WireGuard security group."
  value       = aws_security_group.wireguard.id
}

output "availability_zone" {
  description = "Availability zone the instance was deployed into."
  value       = aws_subnet.public.availability_zone
}

output "ssh_command" {
  description = "Convenience SSH command using the Elastic IP."
  value       = "ssh ubuntu@${aws_eip.wireguard.public_ip}"
}
