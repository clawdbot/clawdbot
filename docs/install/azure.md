---
summary: "Run OpenClaw Gateway 24/7 on an Azure Linux VM with durable state"
read_when:
  - You want OpenClaw running 24/7 on Azure with Network Security Group hardening
  - You want a production-grade, always-on OpenClaw Gateway on your own Azure Linux VM
  - You want secure administration with Azure Bastion SSH
title: "Azure"
---

This guide sets up an Azure Linux VM with the Azure CLI, applies Network Security Group (NSG) hardening, configures Azure Bastion for SSH access, and installs OpenClaw.

## What you will do

- Create Azure networking (VNet, subnets, NSG) and compute resources with the Azure CLI
- Apply Network Security Group rules so VM SSH is allowed only from Azure Bastion
- Use Azure Bastion for SSH access (no public IP on the VM)
- Install OpenClaw with the installer script
- Verify the Gateway

## What you need

- An Azure subscription with permission to create compute and network resources
- Azure CLI installed (see [Azure CLI install steps](https://learn.microsoft.com/cli/azure/install-azure-cli) if needed)
- An SSH key pair (the guide covers generating one if needed)
- ~20-30 minutes

## Configure deployment

<Steps>
  <Step title="Sign in to Azure CLI">
    ```bash
    az login
    az extension add -n ssh
    ```

    The `ssh` extension is required for Azure Bastion native SSH tunneling.

  </Step>

  <Step title="Register required resource providers (one-time)">
    ```bash
    az provider register --namespace Microsoft.Compute
    az provider register --namespace Microsoft.Network
    ```

    Verify registration. Wait until both show `Registered`.

    ```bash
    az provider show --namespace Microsoft.Compute --query registrationState -o tsv
    az provider show --namespace Microsoft.Network --query registrationState -o tsv
    ```

  </Step>

  <Step title="Set deployment variables">
    ```bash
    RG="rg-openclaw"
    LOCATION="westus2"
    VNET_NAME="vnet-openclaw"
    VNET_PREFIX="10.40.0.0/16"
    VM_SUBNET_NAME="snet-openclaw-vm"
    VM_SUBNET_PREFIX="10.40.2.0/24"
    BASTION_SUBNET_PREFIX="10.40.1.0/26"
    NSG_NAME="nsg-openclaw-vm"
    VM_NAME="vm-openclaw"
    ADMIN_USERNAME="openclaw"
    BASTION_NAME="bas-openclaw"
    BASTION_PIP_NAME="pip-openclaw-bastion"
    ```

    Adjust names and CIDR ranges to fit your environment. The Bastion subnet must be at least `/26`.

  </Step>

  <Step title="Select SSH key">
    Use your existing public key if you have one:

    ```bash
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

    If you don't have an SSH key yet, generate one:

    ```bash
    ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_ed25519 -C "you@example.com"
    SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)"
    ```

  </Step>

  <Step title="Select VM size and OS disk size">
    ```bash
    VM_SIZE="Standard_B2as_v2"
    OS_DISK_SIZE_GB=64
    ```

    Choose a VM size and OS disk size available in your subscription and region:

    - Start smaller for light usage and scale up later
    - Use more vCPU/RAM/disk for heavier automation, more channels, or larger model/tool workloads
    - If a VM size is unavailable in your region or subscription quota, pick the closest available SKU

    List VM sizes available in your target region:

    ```bash
    az vm list-skus --location "${LOCATION}" --resource-type virtualMachines -o table
    ```

    Check your current vCPU and disk usage/quota:

    ```bash
    az vm list-usage --location "${LOCATION}" -o table
    ```

  </Step>
</Steps>

## Deploy Azure resources

<Steps>
  <Step title="Create the resource group">
    ```bash
    az group create -n "${RG}" -l "${LOCATION}"
    ```
  </Step>

  <Step title="Create the network security group">
    Create the NSG and add rules so only the Bastion subnet can SSH into the VM.

    ```bash
    az network nsg create \
      -g "${RG}" -n "${NSG_NAME}" -l "${LOCATION}"

    # Allow SSH from the Bastion subnet only
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n AllowSshFromBastionSubnet --priority 100 \
      --access Allow --direction Inbound --protocol Tcp \
      --source-address-prefixes "${BASTION_SUBNET_PREFIX}" \
      --destination-port-ranges 22

    # Deny SSH from the public internet
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyInternetSsh --priority 110 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes Internet \
      --destination-port-ranges 22

    # Deny SSH from other VNet sources
    az network nsg rule create \
      -g "${RG}" --nsg-name "${NSG_NAME}" \
      -n DenyVnetSsh --priority 120 \
      --access Deny --direction Inbound --protocol Tcp \
      --source-address-prefixes VirtualNetwork \
      --destination-port-ranges 22
    ```

    The rules are evaluated by priority (lowest number first): Bastion traffic is allowed at 100, then all other SSH is blocked at 110 and 120.

  </Step>

  <Step title="Create the virtual network and subnets">
    Create the VNet with the VM subnet (NSG attached), then add the Bastion subnet.

    ```bash
    az network vnet create \
      -g "${RG}" -n "${VNET_NAME}" -l "${LOCATION}" \
      --address-prefixes "${VNET_PREFIX}" \
      --subnet-name "${VM_SUBNET_NAME}" \
      --subnet-prefixes "${VM_SUBNET_PREFIX}"

    # Attach the NSG to the VM subnet
    az network vnet subnet update \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n "${VM_SUBNET_NAME}" --nsg "${NSG_NAME}"

    # AzureBastionSubnet — name is required by Azure
    az network vnet subnet create \
      -g "${RG}" --vnet-name "${VNET_NAME}" \
      -n AzureBastionSubnet \
      --address-prefixes "${BASTION_SUBNET_PREFIX}"
    ```

  </Step>

  <Step title="Create the VM">
    The VM has no public IP. SSH access is exclusively through Azure Bastion.

    ```bash
    az vm create \
      -g "${RG}" -n "${VM_NAME}" -l "${LOCATION}" \
      --image "Canonical:ubuntu-24_04-lts:server:latest" \
      --size "${VM_SIZE}" \
      --os-disk-size-gb "${OS_DISK_SIZE_GB}" \
      --storage-sku StandardSSD_LRS \
      --admin-username "${ADMIN_USERNAME}" \
      --ssh-key-values "${SSH_PUB_KEY}" \
      --vnet-name "${VNET_NAME}" \
      --subnet "${VM_SUBNET_NAME}" \
      --public-ip-address "" \
      --nsg ""
    ```

    `--public-ip-address ""` prevents a public IP from being assigned. `--nsg ""` skips creating a per-NIC NSG (the subnet-level NSG handles security).

    **Reproducibility:** The command above uses `latest` for the Ubuntu image. To pin a specific version, list available versions and replace `latest`:

    ```bash
    az vm image list \
      --publisher Canonical --offer ubuntu-24_04-lts \
      --sku server --all -o table
    ```

  </Step>

  <Step title="Create Azure Bastion">
    Azure Bastion provides managed SSH access to the VM without exposing a public IP. Standard SKU with tunneling is required for CLI-based `az network bastion ssh`.

    ```bash
    az network public-ip create \
      -g "${RG}" -n "${BASTION_PIP_NAME}" -l "${LOCATION}" \
      --sku Standard --allocation-method Static

    az network bastion create \
      -g "${RG}" -n "${BASTION_NAME}" -l "${LOCATION}" \
      --vnet-name "${VNET_NAME}" \
      --public-ip-address "${BASTION_PIP_NAME}" \
      --sku Standard --enable-tunneling true
    ```

    Bastion provisioning typically takes 5-10 minutes but can take up to 15-30 minutes in some regions.

  </Step>
</Steps>

## Install OpenClaw

<Steps>
  <Step title="SSH into the VM through Azure Bastion">
    ```bash
    VM_ID="$(az vm show -g "${RG}" -n "${VM_NAME}" --query id -o tsv)"

    az network bastion ssh \
      --name "${BASTION_NAME}" \
      --resource-group "${RG}" \
      --target-resource-id "${VM_ID}" \
      --auth-type ssh-key \
      --username "${ADMIN_USERNAME}" \
      --ssh-key ~/.ssh/id_ed25519
    ```

  </Step>

  <Step title="Install OpenClaw (in the VM shell)">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh -o /tmp/install.sh
    bash /tmp/install.sh
    rm -f /tmp/install.sh
    ```

    The installer installs Node LTS and dependencies if not already present, installs OpenClaw, and launches the onboarding wizard. See [Install](/install) for details.

  </Step>

  <Step title="Verify the Gateway">
    After onboarding completes:

    ```bash
    openclaw gateway status
    ```

    Most enterprise Azure teams already have GitHub Copilot licenses. If that is your case, we recommend choosing the GitHub Copilot provider in the OpenClaw onboarding wizard. See [GitHub Copilot provider](/providers/github-copilot).

  </Step>
</Steps>

## Cost considerations

Azure Bastion Standard SKU runs approximately **\$140/month** and the VM (Standard_B2as_v2) runs approximately **\$55/month**.

To reduce costs:

- **Deallocate the VM** when not in use (stops compute billing; disk charges remain). The OpenClaw Gateway will not be reachable while the VM is deallocated — restart it when you need it live again:

  ```bash
  az vm deallocate -g "${RG}" -n "${VM_NAME}"
  az vm start -g "${RG}" -n "${VM_NAME}"   # restart later
  ```

- **Delete Bastion when not needed** and recreate it when you need SSH access. Bastion is the largest cost component and takes only a few minutes to provision.
- **Use the Basic Bastion SKU** (~\$38/month) if you only need Portal-based SSH and don't require CLI tunneling (`az network bastion ssh`).

## Cleanup

To delete all resources created by this guide:

```bash
az group delete -n "${RG}" --yes --no-wait
```

This removes the resource group and everything inside it (VM, VNet, NSG, Bastion, public IP).

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- For more details on OpenClaw Azure deployment with the GitHub Copilot model provider: [OpenClaw on Azure with GitHub Copilot](https://github.com/johnsonshi/openclaw-azure-github-copilot)

## Related

- [Install overview](/install)
- [GCP](/install/gcp)
- [DigitalOcean](/install/digitalocean)
