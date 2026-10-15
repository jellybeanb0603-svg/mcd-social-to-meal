param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$taskNode = Get-Command node -ErrorAction Stop
& $taskNode.Source (Join-Path $PSScriptRoot 'live_server.mjs') --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
