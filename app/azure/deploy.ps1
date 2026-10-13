param([Parameter(Mandatory=$true)][string]$AzPath,[Parameter(Mandatory=$true)][string]$AppName,[Parameter(Mandatory=$true)][string]$ZipPath,[string]$ResourceGroup='rg-moura-demo')
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $ZipPath -PathType Leaf)){throw 'ZIP inexistente.'}
# Recursos/SQL/Blob/identidade/EasyAuth devem estar configurados antes desta etapa.
& $AzPath webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $ZipPath --type zip --restart true --output none
if($LASTEXITCODE -ne 0){throw 'Falha na implantação; não anunciar publicação.'}
& $AzPath webapp show --resource-group $ResourceGroup --name $AppName --query '{host:defaultHostName,state:state,httpsOnly:httpsOnly}' --output json
if($LASTEXITCODE -ne 0){throw 'Falha na leitura de confirmação.'}
