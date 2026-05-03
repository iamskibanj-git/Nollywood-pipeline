Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }
if (Test-Path ".git\index2.lock") { Remove-Item ".git\index2.lock" -Force }
if (Test-Path ".git\HEAD.lock") { Remove-Item ".git\HEAD.lock" -Force }

$msg = @"
Session 30N: Thorough script engine review

TODO: Fill in after review is complete
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
