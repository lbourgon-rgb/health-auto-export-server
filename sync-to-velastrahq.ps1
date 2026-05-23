# Health Auto Export -> VelastrahQ Vitals Sync
# Pulls latest health data from local HAE server and pushes to VelastrahQ worker
# Run manually or schedule via Task Scheduler

param(
    [switch]$DryRun
)

# Ensure Docker is running
$dockerRunning = $false
try { $null = docker info 2>$null; if ($LASTEXITCODE -eq 0) { $dockerRunning = $true } } catch {}
if (-not $dockerRunning) {
    Write-Host "Docker not running, starting..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    $timeout = 120; $elapsed = 0
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 5; $elapsed += 5
        try { $null = docker info 2>$null; if ($LASTEXITCODE -eq 0) { $dockerRunning = $true; break } } catch {}
    }
    if (-not $dockerRunning) { Write-Host "Docker failed to start"; exit 1 }
    # Ensure containers are up
    Push-Location "C:\Users\Allen\Mini-pc-repo\health-auto-export-server"
    docker compose up -d 2>$null
    Pop-Location
    Start-Sleep -Seconds 5
}

$HAE_URL = "http://localhost:3001/api/metrics"
$HAE_READ_TOKEN = $env:HAE_READ_TOKEN

# Try API worker first, fall back to gateway if needed
$VELASTRAHQ_API_URL = "https://velastrahq-api.lbourgon.workers.dev/api/health"
$VELASTRAHQ_GW_URL  = "https://velastrahq-gw.lbourgon.workers.dev/api/health"
$VELASTRAHQ_SUMMARY_URL = "https://velastrahq-api.lbourgon.workers.dev/api/vel/summary"
$VELASTRAHQ_API_KEY = $env:VELASTRAHQ_API_KEY

# Notion - Body Comp Metrics database
# Get a permanent token: notion.so/profile/integrations -> New integration -> copy secret
# Then share the Body Composition Change page with the integration (... -> Connections)
$NOTION_TOKEN = $env:NOTION_TOKEN
$NOTION_DB_ID = $env:NOTION_DB_ID

if (-not $HAE_READ_TOKEN) {
    Write-Host "HAE_READ_TOKEN is not set."
    exit 1
}

if (-not $VELASTRAHQ_API_KEY) {
    Write-Host "VELASTRAHQ_API_KEY is not set."
    exit 1
}

$haeHeaders = @{ "api-key" = $HAE_READ_TOKEN }
$velHeaders = @{
    "Content-Type"  = "application/json"
    "Authorization" = "Bearer $VELASTRAHQ_API_KEY"
}

function Get-LatestMetric($metricName) {
    try {
        $r = Invoke-RestMethod -Uri "$HAE_URL/$metricName" -Headers $haeHeaders -TimeoutSec 10
        if ($r -and $r.Count -gt 0) {
            # Sort by date descending, return most recent
            $sorted = $r | Sort-Object { [datetime]$_.date } -Descending
            return $sorted[0]
        }
    } catch {
        Write-Host "  Warning: Could not fetch $metricName - $($_.Exception.Message)"
    }
    return $null
}

function Get-LatestDailySumMetric($metricName) {
    try {
        $r = Invoke-RestMethod -Uri "$HAE_URL/$metricName" -Headers $haeHeaders -TimeoutSec 10
        if ($r -and $r.Count -gt 0) {
            $latestDate = $r |
                Where-Object { $_.date -and $_.qty -ne $null } |
                ForEach-Object { ([datetime]$_.date).ToString("yyyy-MM-dd") } |
                Sort-Object -Descending |
                Select-Object -First 1

            if ($latestDate) {
                $dailyRows = @($r | Where-Object {
                    $_.date -and $_.qty -ne $null -and ([datetime]$_.date).ToString("yyyy-MM-dd") -eq $latestDate
                })
                $total = ($dailyRows | Measure-Object -Property qty -Sum).Sum
                $sources = ($dailyRows | ForEach-Object { $_.source } | Where-Object { $_ } | Sort-Object -Unique) -join ", "

                return [pscustomobject]@{
                    date   = $latestDate
                    qty    = $total
                    units  = ($dailyRows | Select-Object -First 1).units
                    source = $sources
                    rows   = $dailyRows.Count
                }
            }
        }
    } catch {
        Write-Host "  Warning: Could not fetch $metricName - $($_.Exception.Message)"
    }
    return $null
}

function Get-DailySumMetric($metricName, $date) {
    if (-not $date) { return $null }
    try {
        $r = Invoke-RestMethod -Uri "$HAE_URL/$metricName" -Headers $haeHeaders -TimeoutSec 10
        $dailyRows = @($r | Where-Object {
            $_.date -and $_.qty -ne $null -and ([datetime]$_.date).ToString("yyyy-MM-dd") -eq $date
        })

        if ($dailyRows.Count -gt 0) {
            $total = ($dailyRows | Measure-Object -Property qty -Sum).Sum
            $sources = ($dailyRows | ForEach-Object { $_.source } | Where-Object { $_ } | Sort-Object -Unique) -join ", "

            return [pscustomobject]@{
                date   = $date
                qty    = $total
                units  = ($dailyRows | Select-Object -First 1).units
                source = $sources
                rows   = $dailyRows.Count
            }
        }
    } catch {
        Write-Host "  Warning: Could not fetch $metricName for $date - $($_.Exception.Message)"
    }
    return $null
}

function Get-MetricDate($metric) {
    if ($metric -and $metric.date) {
        return ([datetime]$metric.date).ToString("yyyy-MM-dd")
    }
    return $null
}

function Get-VelPelvicFloorState {
    try {
        $summary = Invoke-RestMethod -Uri $VELASTRAHQ_SUMMARY_URL -TimeoutSec 15
        $pelvic = $summary.bodyState.pelvicFloor
        if (-not $pelvic) {
            $pelvic = $summary.daily_context.bodyState.pelvicFloor
        }
        if (-not $pelvic -and $summary.uplink -and $summary.uplink.Count -gt 0) {
            $pelvic = $summary.uplink[0].bodyState.pelvicFloor
        }
        return $pelvic
    } catch {
        Write-Host "  Warning: Could not fetch Vel pelvic floor state - $($_.Exception.Message)"
    }
    return $null
}

function Get-NotionDatabaseProperties {
    param($Headers)

    try {
        $db = Invoke-RestMethod -Uri "https://api.notion.com/v1/databases/$NOTION_DB_ID" -Headers $Headers -TimeoutSec 15
        return $db.properties
    } catch {
        Write-Host "  Warning: Could not fetch Notion database schema - $($_.Exception.Message)"
    }
    return $null
}

function Get-ExistingNotionPropertyName {
    param(
        $Schema,
        [string[]]$Candidates
    )

    if (-not $Schema) { return $null }
    foreach ($candidate in $Candidates) {
        if ($Schema.PSObject.Properties.Name -contains $candidate) {
            return $candidate
        }
    }
    return $null
}

function Add-NotionValueIfPropertyExists {
    param(
        [System.Collections.IDictionary]$Properties,
        $Schema,
        [string[]]$Candidates,
        $Value
    )

    if ($Value -eq $null) { return }

    $propName = Get-ExistingNotionPropertyName -Schema $Schema -Candidates $Candidates
    if (-not $propName) {
        $label = $Candidates[0]
        Write-Host "  Notion schema missing '$label'; skipping this pelvic field."
        return
    }

    $propType = $Schema.$propName.type
    switch ($propType) {
        'number' {
            $numberValue = 0.0
            if ([double]::TryParse([string]$Value, [ref]$numberValue)) {
                $Properties[$propName] = @{ number = $numberValue }
            }
        }
        'select' {
            $textValue = [string]$Value
            if ($textValue.Trim()) {
                $Properties[$propName] = @{ select = @{ name = $textValue.Trim() } }
            }
        }
        'multi_select' {
            $items = @($Value) | Where-Object { $_ -ne $null -and ([string]$_).Trim() } | ForEach-Object {
                @{ name = ([string]$_).Trim() }
            }
            if ($items.Count -gt 0) {
                $Properties[$propName] = @{ multi_select = $items }
            }
        }
        'rich_text' {
            $textValue = [string]$Value
            if ($textValue.Trim()) {
                $Properties[$propName] = @{ rich_text = @(@{ text = @{ content = $textValue.Trim() } }) }
            }
        }
        default {
            $textValue = [string]$Value
            if ($textValue.Trim()) {
                $Properties[$propName] = @{ rich_text = @(@{ text = @{ content = $textValue.Trim() } }) }
            }
        }
    }
}

function Add-PelvicFloorNotionProperties {
    param(
        [System.Collections.IDictionary]$Properties,
        $Schema,
        $Pelvic
    )

    if (-not $Pelvic) {
        Write-Host "  No Vel pelvic floor state found in summary payload."
        return
    }

    $locations = @($Pelvic.primaryPainLocation) | Where-Object { $_ }
    $compensations = @($Pelvic.compensationPattern) | Where-Object { $_ }
    $notes = if ($Pelvic.notes) {
        $text = [string]$Pelvic.notes
        if ($text.Length -gt 500) { $text.Substring(0, 500) } else { $text }
    } else {
        $null
    }

    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Pelvic Floor Status', 'Pelvic Status') -Value $Pelvic.pelvicFloorStatus
    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Glute Max Activation', 'Glute Activation') -Value $Pelvic.gluteMaxActivation
    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Pelvic Pain Level', 'Pain Level') -Value $Pelvic.painLevel
    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Pelvic Pain Locations', 'Primary Pain Location', 'Primary Pain Locations') -Value $locations
    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Pelvic Compensation Pattern', 'Compensation Pattern') -Value $compensations
    Add-NotionValueIfPropertyExists -Properties $Properties -Schema $Schema -Candidates @('Pelvic Notes', 'Notes') -Value $notes
}

function New-NotionProperties {
    param(
        [string]$Date,
        [Nullable[double]]$WeightLbs,
        [Nullable[double]]$BodyFatPct,
        [Nullable[double]]$LeanLbs,
        [Nullable[double]]$ProteinG
    )

    $props = [ordered]@{
        "Entry"    = @{ title = @(@{ text = @{ content = "Body Comp - $Date" } }) }
        "Date"     = @{ date = @{ start = $Date } }
        "Source"   = @{ select = @{ name = "Smart Scale" } }
    }

    if ($WeightLbs -ne $null)  { $props["Weight (lbs)"] = @{ number = $WeightLbs } }
    if ($BodyFatPct -ne $null) { $props["Body Fat %"] = @{ number = $BodyFatPct } }
    if ($LeanLbs -ne $null)    { $props["Lean Mass (lbs)"] = @{ number = $LeanLbs } }
    if ($ProteinG -ne $null)   { $props["Protein (g)"] = @{ number = $ProteinG } }

    return $props
}

Write-Host "=== Health Auto Export -> VelastrahQ Sync ==="
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# Health-check HAE server first
Write-Host "Checking HAE server..."
try {
    $health = Invoke-RestMethod -Uri "$HAE_URL/resting_heart_rate?limit=1" -Headers $haeHeaders -TimeoutSec 5
    Write-Host "  HAE server responding OK"
} catch {
    Write-Host "  HAE server not responding. Is Docker running? Is the container up?"
    Write-Host "  Error: $($_.Exception.Message)"
    exit 1
}
Write-Host ""

# Fetch all relevant metrics
Write-Host "Fetching metrics from HAE..."
$restingHR  = Get-LatestMetric "resting_heart_rate"
$hrv        = Get-LatestMetric "heart_rate_variability"
$energyLatest = Get-LatestDailySumMetric "active_energy"
$respRate   = Get-LatestMetric "respiratory_rate"
$sleep      = Get-LatestMetric "sleep_analysis"
$weightKg   = Get-LatestMetric "weight_body_mass"
$bodyFatPct = Get-LatestMetric "body_fat_percentage"
$leanKg     = Get-LatestMetric "lean_body_mass"
$protein    = Get-LatestMetric "protein"

# Determine the latest complete health day from watch-backed daily metrics.
# Step count can receive tiny iPhone-only rows after the watch snapshot, so it should not choose the sync date.
$dates = @($restingHR, $hrv, $energyLatest, $respRate, $sleep) | Where-Object { $_ } | ForEach-Object {
    ([datetime]$_.date).ToString("yyyy-MM-dd")
}
$syncDate = ($dates | Sort-Object -Descending | Select-Object -First 1)

if (-not $syncDate) {
    Write-Host "No health data found to sync!"
    exit 1
}

$steps  = Get-DailySumMetric "step_count" $syncDate
$energy = Get-DailySumMetric "active_energy" $syncDate

Write-Host "  Sync date: $syncDate"
Write-Host "  Resting HR: $(if ($restingHR) { $restingHR.qty } else { 'n/a' })"
Write-Host "  HRV: $(if ($hrv) { [math]::Round($hrv.qty, 1) } else { 'n/a' })"
Write-Host "  Steps: $(if ($steps) { ('{0} from {1} row(s)' -f [math]::Round($steps.qty), $steps.rows) } else { 'n/a' })"
Write-Host "  Active Energy: $(if ($energy) { ('{0} kJ from {1} row(s)' -f [math]::Round($energy.qty), $energy.rows) } else { 'n/a' })"
Write-Host "  Respiratory Rate: $(if ($respRate) { [math]::Round($respRate.qty, 1) } else { 'n/a' })"
Write-Host ""

# Build the payload for VelastrahQ
$payload = @{
    date             = $syncDate
    resting_hr       = if ($restingHR) { [math]::Round($restingHR.qty) } else { $null }
    hrv              = if ($hrv) { [math]::Round($hrv.qty, 1) } else { $null }
    steps            = if ($steps) { [math]::Round($steps.qty) } else { $null }
    active_energy    = if ($energy) { [math]::Round($energy.qty) } else { $null }
    respiratory_rate = if ($respRate) { [math]::Round($respRate.qty, 1) } else { $null }
}

# Add sleep if available (sleep_analysis uses inBed/core/deep/rem fields, not qty)
if ($sleep) {
    $totalSleep = ($sleep.core + $sleep.deep + $sleep.rem)
    $payload.sleep_hours = [math]::Round($totalSleep, 1)
    # Quality score: weight deep+rem higher (0-5 scale)
    if ($totalSleep -gt 0) {
        $deepRemRatio = ($sleep.deep + $sleep.rem) / $totalSleep
        $durationScore = [math]::Min($totalSleep / 8.0, 1.0) * 2.5  # up to 2.5 for 8+ hrs
        $qualityScore = $deepRemRatio * 2.5                           # up to 2.5 for good deep+rem
        $payload.sleep_quality = [math]::Round($durationScore + $qualityScore, 1)
    }
    Write-Host "  Sleep: $($payload.sleep_hours)h (core=$([math]::Round($sleep.core,1)) deep=$([math]::Round($sleep.deep,1)) rem=$([math]::Round($sleep.rem,1))) quality=$($payload.sleep_quality)"
}

$json = $payload | ConvertTo-Json -Compress

if ($DryRun) {
    Write-Host ""
    Write-Host "DRY RUN: would push vitals payload:"
    Write-Host "  $json"
    Write-Host "DRY RUN: skipping VelastrahQ and Notion writes."
    exit 0
}

# Try API worker first, then gateway as fallback
$pushUrls = @($VELASTRAHQ_API_URL, $VELASTRAHQ_GW_URL)
$pushed = $false

foreach ($url in $pushUrls) {
    Write-Host ""
    Write-Host "Pushing to VelastrahQ ($url)..."
    Write-Host "  Payload: $json"

    try {
        $result = Invoke-RestMethod -Uri $url -Method POST -Headers $velHeaders -Body $json -TimeoutSec 15
        Write-Host ""
        Write-Host "SUCCESS: $($result | ConvertTo-Json -Compress)"
        $pushed = $true
        break
    } catch {
        Write-Host ""
        Write-Host "FAILED against $url : $($_.Exception.Message)"
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            Write-Host "Response: $($_.ErrorDetails.Message)"
        } elseif ($_.Exception.Response -and $_.Exception.Response.Content) {
            try {
                $errBody = $_.Exception.Response.Content.ReadAsStringAsync().Result
                Write-Host "Response: $errBody"
            } catch {
                Write-Host "Response: (unable to read response body)"
            }
        }
    }
}

if (-not $pushed) {
    Write-Host ""
    Write-Host "All VelastrahQ endpoints failed. Check worker URLs and API key."
    exit 1
}

# === Push Body Comp to Notion ===
if (-not $NOTION_TOKEN) {
    Write-Host ""
    Write-Host "Skipping Notion push - NOTION_TOKEN not set."
    Write-Host "  Get one: notion.so/profile/integrations -> New integration -> copy secret"
    Write-Host "  Then share 'Body Composition Change' page with the integration (... then Connections)"
    exit 0
}

$weightLbs  = if ($weightKg)   { [math]::Round($weightKg.qty * 2.20462, 1) }   else { $null }
$leanLbs    = if ($leanKg)     { [math]::Round($leanKg.qty * 2.20462, 1) }     else { $null }
$bfPct      = if ($bodyFatPct) { [math]::Round($bodyFatPct.qty, 1) }            else { $null }
$proteinG   = if ($protein)    { [math]::Round($protein.qty, 1) }               else { $null }

# Always key Notion rows by the daily sync date.
# Body-comp metrics can update less frequently (e.g., scale only on some days),
# so using weight date can lock rows to an old day like 2026-03-19.
$bcDate = $syncDate

$weightDate  = Get-MetricDate $weightKg
$bodyFatDate = Get-MetricDate $bodyFatPct
$leanDate    = Get-MetricDate $leanKg
$proteinDate = Get-MetricDate $protein

Write-Host ""
Write-Host "Pushing body comp to Notion ($bcDate)..."
Write-Host "  Weight: $weightLbs lbs  |  Body Fat: $bfPct %  |  Lean: $leanLbs lbs  |  Protein: $proteinG g"
Write-Host "  Source dates -> weight:$weightDate body-fat:$bodyFatDate lean:$leanDate protein:$proteinDate"

$notionHeaders = @{
    "Authorization"  = "Bearer $NOTION_TOKEN"
    "Content-Type"   = "application/json"
    "Notion-Version" = "2022-06-28"
}

$velPelvicFloor = Get-VelPelvicFloorState
$notionSchema = Get-NotionDatabaseProperties -Headers $notionHeaders
if ($velPelvicFloor) {
    Write-Host "  Pelvic floor: status='$($velPelvicFloor.pelvicFloorStatus)' glutes='$($velPelvicFloor.gluteMaxActivation)' pain=$($velPelvicFloor.painLevel)"
}

$hasAnyBodyCompData = ($weightLbs -ne $null) -or ($bfPct -ne $null) -or ($leanLbs -ne $null) -or ($proteinG -ne $null)
$hasAnyPelvicData = $velPelvicFloor -and (
    $velPelvicFloor.pelvicFloorStatus -or
    $velPelvicFloor.gluteMaxActivation -or
    $velPelvicFloor.notes -or
    (@($velPelvicFloor.primaryPainLocation) | Where-Object { $_ }).Count -gt 0 -or
    (@($velPelvicFloor.compensationPattern) | Where-Object { $_ }).Count -gt 0 -or
    ([double]$velPelvicFloor.painLevel) -gt 0
)
if (-not $hasAnyBodyCompData -and -not $hasAnyPelvicData) {
    Write-Host "NOTION SKIP: no body comp/protein or pelvic values available for this run."
    exit 0
}

$notionProps = New-NotionProperties -Date $bcDate -WeightLbs $weightLbs -BodyFatPct $bfPct -LeanLbs $leanLbs -ProteinG $proteinG
Add-PelvicFloorNotionProperties -Properties $notionProps -Schema $notionSchema -Pelvic $velPelvicFloor

try {
    # Upsert: one row per day using the Date property.
    $queryBody = @{
        filter = @{
            property = "Date"
            date     = @{ equals = $bcDate }
        }
        page_size = 5
    } | ConvertTo-Json -Depth 10 -Compress

    $queryResult = Invoke-RestMethod -Uri "https://api.notion.com/v1/databases/$NOTION_DB_ID/query" -Method POST -Headers $notionHeaders -Body $queryBody -TimeoutSec 15
    $existing = if ($queryResult.results -and $queryResult.results.Count -gt 0) { $queryResult.results[0] } else { $null }

    if ($existing) {
        $updateBody = @{ properties = $notionProps } | ConvertTo-Json -Depth 10 -Compress
        $ur = Invoke-RestMethod -Uri "https://api.notion.com/v1/pages/$($existing.id)" -Method PATCH -Headers $notionHeaders -Body $updateBody -TimeoutSec 15
        Write-Host "NOTION UPDATED: $($ur.url)"
    } else {
        $createBody = @{
            parent     = @{ database_id = $NOTION_DB_ID }
            properties = $notionProps
        } | ConvertTo-Json -Depth 10 -Compress

        $cr = Invoke-RestMethod -Uri "https://api.notion.com/v1/pages" -Method POST -Headers $notionHeaders -Body $createBody -TimeoutSec 15
        Write-Host "NOTION CREATED: $($cr.url)"
    }
} catch {
    Write-Host "NOTION FAILED: $($_.Exception.Message)"
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        Write-Host "Response: $($_.ErrorDetails.Message)"
    } elseif ($_.Exception.Response -and $_.Exception.Response.Content) {
        Write-Host "Response: $($_.Exception.Response.Content.ReadAsStringAsync().Result)"
    }
}
