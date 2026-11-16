<#
    NCM NowPlaying - sample the PC's SMTC timeline at high rate to measure lag
    -------------------------------------------------------------------------
    Why this exists
    ---------------
    Windows players (Netease PC, QQ Music, browsers, ...) do NOT push a new
    timeline position every millisecond. They publish a new
    MediaTimelineProperties snapshot every now and then (Netease: about once
    per second) and the value stays frozen in between. Reading Position
    without looking at LastUpdatedTime therefore yields a value that is up
    to one full second stale -- which is exactly what a lyrics page fed by
    the PC shows: a stable ~1s lag behind the audio.

    This script samples in-process (no process restart per sample, so the
    measurement itself costs nothing) and prints one CSV row per sample:

        t,pos,dur,age,status

        t      - local wall clock, ms since Unix epoch
        pos    - tl.Position, ms
        dur    - tl.EndTime, ms
        age    - how much has to be added to pos to get the CURRENT position,
                 i.e. (now - LastUpdatedTime) while playing, 0 otherwise.
                 So the live position is always: pos + age
        status - Playing / Paused / ...

    tools/smtc-lag.js and tools/lag-check.js both consume this file.

    Session picking
    ---------------
    Windows keeps sessions around after a player stops, and a dying session
    can report garbage (Position in the 10^14 range, status=Closed). Picking
    "any session with a title" in that situation gives a measurement that is
    pure noise -- it happened once and produced a bogus "4.4s lag" reading.
    So: drop Closed sessions and absurd timelines, prefer Playing.

    ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI unless
    the file has a BOM).
#>

[CmdletBinding()]
param(
    [int]$Samples = 24,
    [int]$IntervalMs = 250
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $resultType) {
    $m = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$mgrT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propsT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$SKIP = @('NCMPhoneBridge', '37412.BetterLyrics')

# Anything past 24h is not a real playhead -- it is a dead session.
$MAX_MS = 86400000

$mgr = Await ($mgrT::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = @($mgr.GetSessions())

$candidates = @()
foreach ($s in $sessions) {
    $id = [string]$s.SourceAppUserModelId
    if ($SKIP -contains $id) { continue }

    $status = ''
    try { $status = $s.GetPlaybackInfo().PlaybackStatus.ToString() } catch { }

    $title = ''
    try {
        $props = Await ($s.TryGetMediaPropertiesAsync()) ($propsT)
        $title = [string]$props.Title
    }
    catch { }

    $pos = -1; $dur = -1
    try {
        $tl = $s.GetTimelineProperties()
        $pos = [int64]$tl.Position.TotalMilliseconds
        $dur = [int64]$tl.EndTime.TotalMilliseconds
    }
    catch { }

    $sane = ($pos -ge 0) -and ($pos -lt $MAX_MS) -and ($dur -lt $MAX_MS)

    $candidates += [pscustomobject]@{
        session  = $s
        id       = $id
        title    = $title
        status   = $status
        sane     = $sane
        duration = $dur
    }
}

# Score, do not take the first one: a player can register an empty shell
# session (0/0 timeline) that still claims Playing. Prefer a real duration.
foreach ($c in $candidates) {
    $r = 0
    if ($c.status -eq 'Playing') { $r += 100 }
    if ($c.title) { $r += 50 }
    if ($c.duration -gt 1000) { $r += 30 }
    $c | Add-Member -NotePropertyName rank -NotePropertyValue $r -Force
}

$usable = @($candidates | Where-Object { $_.sane -and $_.status -ne 'Closed' })
$pick = $usable | Sort-Object -Property rank -Descending | Select-Object -First 1

if (-not $pick) {
    Write-Output "# none"
    exit 0
}

Write-Output ("# session=" + $pick.id + " title=" + $pick.title + " status=" + $pick.status)
Write-Output "t,pos,dur,age,status"

for ($i = 0; $i -lt $Samples; $i++) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $pos = -1; $dur = -1; $age = 0; $status = '?'
    try {
        $tl = $pick.session.GetTimelineProperties()
        $pos = [int64]$tl.Position.TotalMilliseconds
        $dur = [int64]$tl.EndTime.TotalMilliseconds
        $stale = [int64]([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds
    }
    catch { }
    try { $status = $pick.session.GetPlaybackInfo().PlaybackStatus.ToString() } catch { }

    # Only a playing session advances, so only then is the staleness real.
    if ($status -eq 'Playing' -and $stale -ge 0 -and $stale -le 3000) { $age = $stale }

    Write-Output "$now,$pos,$dur,$age,$status"
    if ($i -lt $Samples - 1) { Start-Sleep -Milliseconds $IntervalMs }
}
