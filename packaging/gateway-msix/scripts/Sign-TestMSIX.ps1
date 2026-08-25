[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ArtifactsDirectory,

    [Parameter(Mandatory)]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'Test MSIX signing requires Windows.'
}

$resolvedArtifactsDirectory = (
    Resolve-Path -LiteralPath $ArtifactsDirectory
).Path
$publisher = 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US'

$signtool = Get-ChildItem `
    -LiteralPath "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
    -Filter 'signtool.exe' `
    -File `
    -Recurse |
    Where-Object {
        $_.FullName -match '\\x64\\signtool\.exe$'
    } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if ($null -eq $signtool) {
    throw 'signtool.exe was not found in the Windows SDK.'
}

New-Item -Path $OutputDirectory -ItemType Directory -Force | Out-Null
$temporaryDirectory = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
}
else {
    [IO.Path]::GetTempPath()
}
$temporaryPfx = Join-Path $temporaryDirectory (
    "openclaw-gateway-test-$([guid]::NewGuid().ToString('N')).pfx"
)
$passwordText = [guid]::NewGuid().ToString('N')
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $publisher `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -FriendlyName 'OpenClaw Gateway temporary MSIX test signing' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3') `
    -NotAfter (Get-Date).AddDays(30)

try {
    Export-PfxCertificate `
        -Cert $certificate `
        -FilePath $temporaryPfx `
        -Password $password |
        Out-Null

    foreach ($architecture in @('x64', 'arm64')) {
        $sourceDirectory = Join-Path $resolvedArtifactsDirectory $architecture
        if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
            continue
        }

        $sourceMsix = @(
            Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.msix' -File
        )
        if ($sourceMsix.Count -ne 1) {
            throw (
                "Expected one unsigned $architecture MSIX in " +
                "'$sourceDirectory'; found $($sourceMsix.Count)."
            )
        }

        $sourceMetadataPath = Join-Path $sourceDirectory 'msix-metadata.json'
        if (-not (Test-Path -LiteralPath $sourceMetadataPath -PathType Leaf)) {
            throw "Missing $architecture MSIX metadata."
        }

        $destinationDirectory = Join-Path $OutputDirectory $architecture
        New-Item `
            -Path $destinationDirectory `
            -ItemType Directory `
            -Force |
            Out-Null
        $signedMsixPath = Join-Path `
            $destinationDirectory `
            $sourceMsix[0].Name
        Copy-Item `
            -LiteralPath $sourceMsix[0].FullName `
            -Destination $signedMsixPath `
            -Force

        & $signtool.FullName sign `
            /fd SHA256 `
            /f $temporaryPfx `
            /p $passwordText `
            $signedMsixPath
        if ($LASTEXITCODE -ne 0) {
            throw "Test signing failed for $architecture with exit code $LASTEXITCODE."
        }

        $signature = Get-AuthenticodeSignature -LiteralPath $signedMsixPath
        if (
            $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint
        ) {
            throw "The $architecture test signature was not applied."
        }

        $certificatePath = Join-Path `
            $destinationDirectory `
            'OpenClawGateway-test-signing.cer'
        Export-Certificate `
            -Cert $certificate `
            -FilePath $certificatePath `
            -Type CERT |
            Out-Null

        $metadata = Get-Content -LiteralPath $sourceMetadataPath -Raw |
            ConvertFrom-Json
        $metadata.sha256 = (
            Get-FileHash -LiteralPath $signedMsixPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        $metadata.signed = $true
        $metadata | Add-Member `
            -NotePropertyName signingType `
            -NotePropertyValue test `
            -Force
        $metadata | Add-Member `
            -NotePropertyName signingCertificateThumbprint `
            -NotePropertyValue $certificate.Thumbprint `
            -Force
        $metadata |
            ConvertTo-Json |
            Set-Content `
                -LiteralPath (
                    Join-Path $destinationDirectory 'msix-metadata.json'
                ) `
                -Encoding utf8
    }
}
finally {
    Remove-Item -LiteralPath $temporaryPfx -Force -ErrorAction SilentlyContinue
    Remove-Item `
        -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" `
        -Force `
        -ErrorAction SilentlyContinue
}

Write-Host "Created test-signed MSIX artifacts under: $OutputDirectory"
