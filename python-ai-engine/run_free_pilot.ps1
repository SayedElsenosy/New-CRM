# SET CRM: Groq Free-only 3-case synthetic pilot on Windows.
# Never stores or transmits the key to GitHub/ChatGPT. Runs locally only.
param([switch]$DryRun, [ValidateRange(1,3)][int]$MaxCases = 1)
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    if ($DryRun) {
        py -3 -m shadow_ai.live_eval --dry-run
        if ($LASTEXITCODE -ne 0) { throw "Python dry-run failed" }
        return
    }

    Write-Host ""
    Write-Host "Groq Free pilot - up to 3 synthetic cases; first retry is 1 case only." -ForegroundColor Cyan
    Write-Host "Before proceeding, open Groq Console > Settings > Billing"
    Write-Host "Verify the current organization says FREE (not Developer),"
    Write-Host "and don't upgrade or add a payment method. Free usage has rate limits."
    $answer = Read-Host "Type FREE (uppercase) only after confirming the Groq Free plan"
    if ($answer -cne "FREE") {
        Write-Host "Not confirmed; no provider requests sent." -ForegroundColor Yellow
        return
    }

    Write-Host "Use a NEW key created for this free test project, not the live bot key."
    $secure = Read-Host "Paste the test-only Groq API key here (hidden)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:SHADOW_GROQ_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    $env:SHADOW_LLM_NETWORK_ENABLED = "YES"
    $env:SHADOW_GROQ_FREE_TIER_CONFIRMED = "YES"
    $env:SHADOW_GROQ_MODEL = "openai/gpt-oss-20b"

    py -3 -m shadow_ai.live_eval --live --synthetic-only-confirmed --confirm-free-tier --max-cases $MaxCases
    if ($LASTEXITCODE -ne 0) { throw "Evaluation failed; see only the safe error above" }
}
finally {
    # Always remove ephemeral credentials and flags from this PowerShell process.
    Remove-Item Env:SHADOW_GROQ_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOW_LLM_NETWORK_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOW_GROQ_FREE_TIER_CONFIRMED -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOW_GROQ_MODEL -ErrorAction SilentlyContinue
    Pop-Location
}
