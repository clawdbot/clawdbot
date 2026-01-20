param(
  [string]$Distro = "Ubuntu-20.04",
  [string[]]$Ports = @("2222:22", "5002:5002"),
  [string]$ListenAddress = "0.0.0.0"
)

$ip = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $ip) { throw "WSL IP not found." }

foreach ($mapping in $Ports) {
  $parts = $mapping.Split(":")
  if ($parts.Length -ne 2) { throw "Invalid port mapping: $mapping (use listen:connect)" }
  $listenPort = [int]$parts[0]
  $connectPort = [int]$parts[1]

  netsh interface portproxy delete v4tov4 listenport=$listenPort listenaddress=$ListenAddress | Out-Null
  netsh interface portproxy add v4tov4 listenport=$listenPort listenaddress=$ListenAddress `
    connectport=$connectPort connectaddress=$ip | Out-Null

  Write-Host "Portproxy $ListenAddress:$listenPort -> $ip:$connectPort"
}
