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
$VELASTRAHQ_JOURNALS_URL = "https://velastrahq-api.lbourgon.workers.dev/api/vel/journals?limit=50"
$VELASTRAHQ_API_KEY = $env:VELASTRAHQ_API_KEY

# Notion - Body Comp Metrics database
# Get a permanent token: notion.so/profile/integrations -> New integration -> copy secret
# Then share the Body Composition Change page with the integration (... -> Connections)
$NOTION_TOKEN = $env:NOTION_TOKEN
$NOTION_DB_ID = $env:NOTION_DB_ID
$NOTION_DAILY_CHECKIN_DB_ID = if ($env:NOTION_DAILY_CHECKIN_DB_ID) { $env:NOTION_DAILY_CHECKIN_DB_ID } else { "29a51a68c707814c8182ca107aabbf09" }
$NOTION_DAILY_JOURNAL_DB_ID = if ($env:NOTION_DAILY_JOURNAL_DB_ID) { $env:NOTION_DAILY_JOURNAL_DB_ID } else { "29a51a68c70781e3bb16d36fe79068e7" }
$NOTION_TASKS_DB_ID = if ($env:NOTION_TASKS_DB_ID) { $env:NOTION_TASKS_DB_ID } else { "29a51a68c7078198bd30e1b8e47a074a" }
$NOTION_HOUSEHOLD_DB_ID = if ($env:NOTION_HOUSEHOLD_DB_ID) { $env:NOTION_HOUSEHOLD_DB_ID } else { "29a51a68c7078138833eead318a726ca" }

# Optional Google Calendar bridge. Requires an OAuth bearer token with Calendar write access.
$GOOGLE_CALENDAR_ID = $env:GOOGLE_CALENDAR_ID
$GOOGLE_CALENDAR_ACCESS_TOKEN = $env:GOOGLE_CALENDAR_ACCESS_TOKEN

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

function Get-VelSummary {
    try {
        return Invoke-RestMethod -Uri $VELASTRAHQ_SUMMARY_URL -TimeoutSec 15
    } catch {
        Write-Host "  Warning: Could not fetch Vel summary - $($_.Exception.Message)"
    }
    return $null
}

function Get-VelPelvicFloorState {
    param($Summary)

    if (-not $Summary) { return $null }
    $pelvic = $Summary.bodyState.pelvicFloor
    if (-not $pelvic) {
        $pelvic = $Summary.daily_context.bodyState.pelvicFloor
    }
    if (-not $pelvic -and $Summary.uplink -and $Summary.uplink.Count -gt 0) {
        $pelvic = $Summary.uplink[0].bodyState.pelvicFloor
    }
    return $pelvic
}

function Get-VelJournals {
    try {
        $payload = Invoke-RestMethod -Uri $VELASTRAHQ_JOURNALS_URL -TimeoutSec 15
        return @($payload.entries)
    } catch {
        Write-Host "  Warning: Could not fetch Vel journals - $($_.Exception.Message)"
    }
    return @()
}

function Get-NotionDatabaseProperties {
    param(
        $Headers,
        [string]$DatabaseId
    )

    try {
        $db = Invoke-RestMethod -Uri "https://api.notion.com/v1/databases/$DatabaseId" -Headers $Headers -TimeoutSec 15
        return $db.properties
    } catch {
        Write-Host "  Warning: Could not fetch Notion database schema for $DatabaseId - $($_.Exception.Message)"
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

function Get-NotionPropertyType {
    param(
        $Schema,
        [string]$PropertyName
    )

    if (-not $Schema -or -not $PropertyName) { return $null }
    $prop = $Schema.PSObject.Properties[$PropertyName]
    if ($prop) { return $prop.Value.type }
    return $null
}

function Test-NotionSelectOption {
    param(
        $Schema,
        [string]$PropertyName,
        [string]$OptionName
    )

    if (-not $Schema -or -not $PropertyName -or -not $OptionName) { return $false }
    $prop = $Schema.PSObject.Properties[$PropertyName]
    if (-not $prop) { return $false }
    $propType = $prop.Value.type
    $options = if ($prop.Value.options) {
        $prop.Value.options
    } elseif ($prop.Value.$propType -and $prop.Value.$propType.options) {
        $prop.Value.$propType.options
    } else {
        @()
    }
    return @($options | ForEach-Object { $_.name }) -contains $OptionName
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

    $propType = Get-NotionPropertyType -Schema $Schema -PropertyName $propName
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
                $trimmed = $textValue.Trim()
                if (Test-NotionSelectOption -Schema $Schema -PropertyName $propName -OptionName $trimmed) {
                    $Properties[$propName] = @{ select = @{ name = $trimmed } }
                } else {
                    Write-Host "  Notion select '$propName' has no option '$trimmed'; skipping value."
                }
            }
        }
        'multi_select' {
            $items = New-Object System.Collections.ArrayList
            @($Value) | Where-Object { $_ -ne $null -and ([string]$_).Trim() } | ForEach-Object {
                [void]$items.Add(@{ name = ([string]$_).Trim() })
            }
            if ($items.Count -gt 0) {
                $Properties[$propName] = @{ multi_select = @($items) }
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

function Add-NotionTitleIfPropertyExists {
    param(
        [System.Collections.IDictionary]$Properties,
        $Schema,
        [string[]]$Candidates,
        [string]$Value
    )

    $propName = Get-ExistingNotionPropertyName -Schema $Schema -Candidates $Candidates
    if (-not $propName) {
        Write-Host "  Notion schema missing '$($Candidates[0])'; skipping title."
        return
    }
    if ((Get-NotionPropertyType -Schema $Schema -PropertyName $propName) -ne 'title') {
        Write-Host "  Notion property '$propName' is not a title; skipping title."
        return
    }
    $Properties[$propName] = @{ title = @(@{ text = @{ content = $Value } }) }
}

function Add-NotionDateIfPropertyExists {
    param(
        [System.Collections.IDictionary]$Properties,
        $Schema,
        [string[]]$Candidates,
        [string]$Value
    )

    if (-not $Value) { return }
    $propName = Get-ExistingNotionPropertyName -Schema $Schema -Candidates $Candidates
    if (-not $propName) {
        Write-Host "  Notion schema missing '$($Candidates[0])'; skipping date."
        return
    }
    if ((Get-NotionPropertyType -Schema $Schema -PropertyName $propName) -ne 'date') {
        Write-Host "  Notion property '$propName' is not a date; skipping date."
        return
    }
    $Properties[$propName] = @{ date = @{ start = $Value } }
}

function Normalize-NotionDailyDemand {
    param([string]$Demand)

    if ($Demand -eq "Kids' Activity") { return "Kids Activity" }
    return $Demand
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

function Invoke-NotionQuery {
    param(
        [string]$DatabaseId,
        [hashtable]$Headers,
        [hashtable]$QueryBody
    )

    $jsonBody = $QueryBody | ConvertTo-Json -Depth 20 -Compress
    return Invoke-RestMethod -Uri "https://api.notion.com/v1/databases/$DatabaseId/query" -Method POST -Headers $Headers -Body $jsonBody -TimeoutSec 15
}

function Find-NotionPageByDate {
    param(
        [string]$DatabaseId,
        [hashtable]$Headers,
        [string]$DateProperty,
        [string]$Date
    )

    $queryBody = @{
        filter = @{
            property = $DateProperty
            date     = @{ equals = $Date }
        }
        page_size = 5
    }
    $result = Invoke-NotionQuery -DatabaseId $DatabaseId -Headers $Headers -QueryBody $queryBody
    if ($result.results -and $result.results.Count -gt 0) { return $result.results[0] }
    return $null
}

function Find-NotionPageByRichText {
    param(
        [string]$DatabaseId,
        [hashtable]$Headers,
        [string]$Property,
        [string]$Value
    )

    $queryBody = @{
        filter = @{
            property  = $Property
            rich_text = @{ equals = $Value }
        }
        page_size = 1
    }
    $result = Invoke-NotionQuery -DatabaseId $DatabaseId -Headers $Headers -QueryBody $queryBody
    if ($result.results -and $result.results.Count -gt 0) { return $result.results[0] }
    return $null
}

function Invoke-NotionUpsertPage {
    param(
        [string]$DatabaseId,
        [hashtable]$Headers,
        [System.Collections.IDictionary]$Properties,
        $Existing,
        [string]$Label,
        [switch]$DryRun
    )

    if ($DryRun) {
        $verb = if ($Existing) { 'update' } else { 'create' }
        Write-Host "DRY RUN: would $verb Notion $Label"
        Write-Host ($Properties | ConvertTo-Json -Depth 20 -Compress)
        return $null
    }

    if ($Existing) {
        $updateBody = @{ properties = $Properties } | ConvertTo-Json -Depth 20 -Compress
        $updated = Invoke-RestMethod -Uri "https://api.notion.com/v1/pages/$($Existing.id)" -Method PATCH -Headers $Headers -Body $updateBody -TimeoutSec 15
        Write-Host "NOTION UPDATED ($Label): $($updated.url)"
        return $updated
    }

    $createBody = @{
        parent     = @{ database_id = $DatabaseId }
        properties = $Properties
    } | ConvertTo-Json -Depth 20 -Compress
    $created = Invoke-RestMethod -Uri "https://api.notion.com/v1/pages" -Method POST -Headers $Headers -Body $createBody -TimeoutSec 15
    Write-Host "NOTION CREATED ($Label): $($created.url)"
    return $created
}

function New-DailyCheckInProperties {
    param(
        $Schema,
        [string]$Date,
        $Summary,
        $Pelvic
    )

    $props = [ordered]@{}
    Add-NotionTitleIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Name') -Value "Daily Check-In - $Date"
    Add-NotionDateIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Date') -Value $Date

    $spoons = $Summary.spoons
    if ($spoons) {
        Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Spoons') -Value $spoons.level
        $spoonsNote = if ($spoons.note) { $spoons.note } else { $spoons.feeling }
        Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Spoons Note') -Value $spoonsNote
    }

    $demands = @($Summary.daily_context.daily_demands) | Where-Object { $_ } | ForEach-Object { Normalize-NotionDailyDemand ([string]$_) }
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Daily Demands') -Value $demands
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('ADHD State') -Value $Summary.daily_context.adhd_state
    Add-PelvicFloorNotionProperties -Properties $props -Schema $Schema -Pelvic $Pelvic
    return $props
}

function Sync-DailyCheckInToNotion {
    param(
        [hashtable]$Headers,
        [string]$Date,
        $Summary,
        $Pelvic,
        [switch]$DryRun
    )

    if (-not $Summary) {
        Write-Host "Skipping Daily Check-In sync - Vel summary unavailable."
        return
    }
    if (-not $NOTION_DAILY_CHECKIN_DB_ID) {
        Write-Host "Skipping Daily Check-In sync - NOTION_DAILY_CHECKIN_DB_ID is not set."
        return
    }

    try {
        $schema = Get-NotionDatabaseProperties -Headers $Headers -DatabaseId $NOTION_DAILY_CHECKIN_DB_ID
        if (-not $schema) { return }
        $props = New-DailyCheckInProperties -Schema $schema -Date $Date -Summary $Summary -Pelvic $Pelvic
        $existing = Find-NotionPageByDate -DatabaseId $NOTION_DAILY_CHECKIN_DB_ID -Headers $Headers -DateProperty 'Date' -Date $Date
        Invoke-NotionUpsertPage -DatabaseId $NOTION_DAILY_CHECKIN_DB_ID -Headers $Headers -Properties $props -Existing $existing -Label "Daily Check-In $Date" -DryRun:$DryRun | Out-Null
    } catch {
        Write-Host "DAILY CHECK-IN NOTION FAILED: $($_.Exception.Message)"
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { Write-Host "Response: $($_.ErrorDetails.Message)" }
    }
}

function ConvertTo-NotionMood {
    param(
        $Schema,
        [string]$Emotion
    )

    if (-not $Emotion) { return $null }
    $trimmed = $Emotion.Trim()
    $options = @($Schema.PSObject.Properties['Mood'].Value.options | ForEach-Object { $_.name })
    foreach ($option in $options) {
        if ($option.ToLowerInvariant() -eq $trimmed.ToLowerInvariant()) { return $option }
    }
    return $null
}

function New-JournalProperties {
    param(
        $Schema,
        $Journal
    )

    $date = if ($Journal.entry_date) { ([datetime]$Journal.entry_date).ToString('yyyy-MM-dd') } else { (Get-Date).ToString('yyyy-MM-dd') }
    $journalId = [string]$Journal.id
    $emotion = if ($Journal.emotion) { [string]$Journal.emotion } else { '' }
    $content = if ($Journal.content) { [string]$Journal.content } else { '' }
    $tags = @()
    if ($Journal.tags) {
        try {
            $parsed = $Journal.tags
            if ($Journal.tags -is [string]) { $parsed = $Journal.tags | ConvertFrom-Json }
            $tags = @($parsed) | Where-Object { $_ }
        } catch {
            $tags = @()
        }
    }

    $props = [ordered]@{}
    Add-NotionTitleIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Name') -Value "Vel Journal - $date - #$journalId"
    Add-NotionDateIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Date') -Value $date
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Source') -Value 'Velastrae'
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Velastrae Journal ID') -Value $journalId
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Emotion') -Value $emotion
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Tags') -Value $tags
    Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Notes') -Value $content

    $mood = ConvertTo-NotionMood -Schema $Schema -Emotion $emotion
    if ($mood) {
        Add-NotionValueIfPropertyExists -Properties $props -Schema $Schema -Candidates @('Mood') -Value @($mood)
    }
    return $props
}

function Sync-VelJournalsToNotion {
    param(
        [hashtable]$Headers,
        [switch]$DryRun
    )

    if (-not $NOTION_DAILY_JOURNAL_DB_ID) {
        Write-Host "Skipping Daily Journal sync - NOTION_DAILY_JOURNAL_DB_ID is not set."
        return
    }

    try {
        $schema = Get-NotionDatabaseProperties -Headers $Headers -DatabaseId $NOTION_DAILY_JOURNAL_DB_ID
        if (-not $schema) { return }
        $journals = Get-VelJournals
        Write-Host "Syncing Vel journals to Notion Daily Journal: $($journals.Count) fetched."
        foreach ($journal in $journals) {
            if (-not $journal.id) { continue }
            $props = New-JournalProperties -Schema $schema -Journal $journal
            $existing = Find-NotionPageByRichText -DatabaseId $NOTION_DAILY_JOURNAL_DB_ID -Headers $Headers -Property 'Velastrae Journal ID' -Value ([string]$journal.id)
            Invoke-NotionUpsertPage -DatabaseId $NOTION_DAILY_JOURNAL_DB_ID -Headers $Headers -Properties $props -Existing $existing -Label "Daily Journal #$($journal.id)" -DryRun:$DryRun | Out-Null
        }
    } catch {
        Write-Host "DAILY JOURNAL NOTION FAILED: $($_.Exception.Message)"
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { Write-Host "Response: $($_.ErrorDetails.Message)" }
    }
}

function Get-OpenNotionItems {
    param(
        [hashtable]$Headers,
        [string]$DatabaseId,
        [string]$TitleProperty,
        [string]$DateProperty,
        [string[]]$OpenStatuses,
        [int]$Limit = 8
    )

    try {
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $queryBody = @{
            filter = @{
                and = @(
                    @{
                        property = $DateProperty
                        date     = @{ on_or_before = $today }
                    },
                    @{
                        property = 'Status'
                        status   = @{ does_not_equal = 'Completed' }
                    }
                )
            }
            page_size = $Limit
        }
        $result = Invoke-NotionQuery -DatabaseId $DatabaseId -Headers $Headers -QueryBody $queryBody
        return @($result.results | ForEach-Object {
            $titleBlocks = $_.properties.$TitleProperty.title
            $title = if ($titleBlocks -and $titleBlocks.Count -gt 0) { ($titleBlocks | ForEach-Object { $_.plain_text }) -join '' } else { 'Untitled' }
            [pscustomobject]@{ title = $title; url = $_.url }
        })
    } catch {
        Write-Host "  Warning: Could not query Notion items from $DatabaseId - $($_.Exception.Message)"
    }
    return @()
}

function Get-NotionItemsByStatus {
    param(
        [hashtable]$Headers,
        [string]$DatabaseId,
        [string]$TitleProperty,
        [string[]]$Statuses,
        [int]$Limit = 8
    )

    $items = New-Object System.Collections.ArrayList
    foreach ($status in $Statuses) {
        try {
            $queryBody = @{
                filter = @{
                    property = 'Status'
                    status   = @{ equals = $status }
                }
                page_size = $Limit
            }
            $result = Invoke-NotionQuery -DatabaseId $DatabaseId -Headers $Headers -QueryBody $queryBody
            foreach ($page in @($result.results)) {
                if ($items.Count -ge $Limit) { break }
                $titleBlocks = $page.properties.$TitleProperty.title
                $title = if ($titleBlocks -and $titleBlocks.Count -gt 0) { ($titleBlocks | ForEach-Object { $_.plain_text }) -join '' } else { 'Untitled' }
                [void]$items.Add([pscustomobject]@{ title = $title; url = $page.url })
            }
        } catch {
            Write-Host "  Warning: Could not query Notion items from $DatabaseId status '$status' - $($_.Exception.Message)"
        }
    }
    return @($items)
}

function Sync-TasksToGoogleCalendar {
    param(
        [hashtable]$NotionHeaders,
        [switch]$DryRun
    )

    if (-not $GOOGLE_CALENDAR_ID -or -not $GOOGLE_CALENDAR_ACCESS_TOKEN) {
        Write-Host "Skipping Google Calendar bridge - GOOGLE_CALENDAR_ID and GOOGLE_CALENDAR_ACCESS_TOKEN are not set."
        return
    }

    $tasks = Get-OpenNotionItems -Headers $NotionHeaders -DatabaseId $NOTION_TASKS_DB_ID -TitleProperty 'Tasks' -DateProperty 'Due Date' -OpenStatuses @('Not Started', 'In Progress') -Limit 8
    $chores = Get-NotionItemsByStatus -Headers $NotionHeaders -DatabaseId $NOTION_HOUSEHOLD_DB_ID -TitleProperty 'Tasks' -Statuses @('Not started', 'In progress') -Limit 8
    $allItems = @($tasks + $chores)
    if ($allItems.Count -eq 0) {
        Write-Host "Google Calendar bridge: no due Notion tasks found."
        return
    }

    $today = (Get-Date).ToString('yyyy-MM-dd')
    $description = ($allItems | ForEach-Object { "- $($_.title)`n  $($_.url)" }) -join "`n"
    $event = @{
        summary     = "Today's Notion Tasks"
        description = $description
        start       = @{ date = $today }
        end         = @{ date = (Get-Date).AddDays(1).ToString('yyyy-MM-dd') }
    }

    if ($DryRun) {
        Write-Host "DRY RUN: would create Google Calendar event"
        Write-Host ($event | ConvertTo-Json -Depth 10 -Compress)
        return
    }

    try {
        $calendarHeaders = @{
            Authorization = "Bearer $GOOGLE_CALENDAR_ACCESS_TOKEN"
            "Content-Type" = "application/json"
        }
        $calendarId = [uri]::EscapeDataString($GOOGLE_CALENDAR_ID)
        $eventBody = $event | ConvertTo-Json -Depth 10 -Compress
        $created = Invoke-RestMethod -Uri "https://www.googleapis.com/calendar/v3/calendars/$calendarId/events" -Method POST -Headers $calendarHeaders -Body $eventBody -TimeoutSec 15
        Write-Host "GOOGLE CALENDAR CREATED: $($created.htmlLink)"
    } catch {
        Write-Host "GOOGLE CALENDAR FAILED: $($_.Exception.Message)"
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { Write-Host "Response: $($_.ErrorDetails.Message)" }
    }
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
    Write-Host "DRY RUN: skipping VelastrahQ write."
} else {
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

$velSummary = Get-VelSummary
$velPelvicFloor = Get-VelPelvicFloorState -Summary $velSummary
$notionSchema = Get-NotionDatabaseProperties -Headers $notionHeaders -DatabaseId $NOTION_DB_ID
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
} else {
    $notionProps = New-NotionProperties -Date $bcDate -WeightLbs $weightLbs -BodyFatPct $bfPct -LeanLbs $leanLbs -ProteinG $proteinG
    Add-PelvicFloorNotionProperties -Properties $notionProps -Schema $notionSchema -Pelvic $velPelvicFloor

    try {
        $existing = Find-NotionPageByDate -DatabaseId $NOTION_DB_ID -Headers $notionHeaders -DateProperty 'Date' -Date $bcDate
        Invoke-NotionUpsertPage -DatabaseId $NOTION_DB_ID -Headers $notionHeaders -Properties $notionProps -Existing $existing -Label "Body Comp $bcDate" -DryRun:$DryRun | Out-Null
    } catch {
        Write-Host "NOTION FAILED: $($_.Exception.Message)"
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            Write-Host "Response: $($_.ErrorDetails.Message)"
        } elseif ($_.Exception.Response -and $_.Exception.Response.Content) {
            Write-Host "Response: $($_.Exception.Response.Content.ReadAsStringAsync().Result)"
        }
    }
}

Write-Host ""
Write-Host "Pushing Vel Daily Check-In to Notion ($bcDate)..."
Sync-DailyCheckInToNotion -Headers $notionHeaders -Date $bcDate -Summary $velSummary -Pelvic $velPelvicFloor -DryRun:$DryRun

Write-Host ""
Write-Host "Pushing Vel journals to Notion Daily Journal..."
Sync-VelJournalsToNotion -Headers $notionHeaders -DryRun:$DryRun

Write-Host ""
Write-Host "Syncing Notion tasks to Google Calendar..."
Sync-TasksToGoogleCalendar -NotionHeaders $notionHeaders -DryRun:$DryRun
