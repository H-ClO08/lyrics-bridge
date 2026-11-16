<#
    NCM NowPlaying - read the PC's currently-playing media session as JSON
    ----------------------------------------------------------------------
    Picks the active SMTC session (excluding our own bridge and BetterLyrics
    itself) and prints a single compact JSON object for smtc-push.js to push
    to the service:

        {"active":true,"title":"...","artist":"...","album":"...",
         "position":12345,"duration":240000,"playing":true,"player":"...",
         "positionRaw":11850,"positionAgeMs":1495,"at":1789358990000}

    position vs positionRaw
    -----------------------
    Windows players do NOT refresh the timeline every millisecond: Netease PC
    publishes a new MediaTimelineProperties snapshot roughly once per second
    and Position stays frozen in between. Reporting that frozen value as "the
    position right now" is what makes a lyrics page lag a full second behind
    the audio (tools/smtc-lag.js measures it).

    The timeline carries LastUpdatedTime (when the snapshot was written), so
    the real position is:

        position = Position + (now - LastUpdatedTime)      while playing

    `position` below is that corrected value -- the position as of `at`;
    `positionRaw` is the untouched SMTC number (diagnostics only);
    `positionAgeMs` is how much was added.

    The correction is skipped (age reported as 0) when the session is not
    playing, or when LastUpdatedTime looks unusable (negative, or older than
    $MAX_AGE_MS) -- some players never refresh it, and adding a bogus age
    would be worse than adding nothing.

    If nothing is playing, prints {"active":false}.

    Set NCM_SMTC_DEBUG=1 to get the raw decision on stderr.

    ASCII only, on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on
    a Chinese Windows) unless the file has a BOM. A UTF-8 Chinese comment then
    decodes to garbage bytes, and when the last garbage byte swallows the
    newline, the NEXT line silently becomes part of the comment -- which is
    how this script once "lost" an assignment without any error at all.
    Keep every comment here in plain English.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Force UTF-8 so the JSON body (which may contain CJK) survives the pipe.
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

# Sessions we must never treat as "the PC is playing":
#  - NCMPhoneBridge is our own phone->PC bridge
#  - 37412.BetterLyrics is the lyrics app's own session
$SKIP = @('NCMPhoneBridge', '37412.BetterLyrics')

# Refuse to trust a snapshot older than this: it means the player does not
# refresh LastUpdatedTime (or that timeline is not really playing), and
# guessing would push the position forward by a bogus amount.
$MAX_AGE_MS = 3000

# Anything past 24h is not a real playhead -- it is a dying session.
$MAX_MS = 86400000

if ($env:NCM_SMTC_DEBUG) { [Console]::Error.WriteLine('[smTc] boot maxAge=' + "$MAX_AGE_MS") }

$result = [pscustomobject]@{
    active        = $false
    title         = ''
    artist        = ''
    album         = ''
    position      = 0
    duration      = 0
    playing       = $false
    player        = ''
    positionRaw   = 0
    positionAgeMs = 0
    at            = 0
}

try {
    $mgr = Await ($mgrT::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $sessions = @($mgr.GetSessions())
    $candidates = @()

    foreach ($s in $sessions) {
        $id = [string]$s.SourceAppUserModelId
        if ($SKIP -contains $id) { continue }

        $playing = $false
        $status = ''
        try {
            $status = $s.GetPlaybackInfo().PlaybackStatus.ToString()
            $playing = ($status -eq 'Playing')
        }
        catch { }

        $title = ''; $artist = ''; $album = ''
        try {
            $props = Await ($s.TryGetMediaPropertiesAsync()) ($propsT)
            $title = [string]$props.Title
            $artist = [string]$props.Artist
            $album = [string]$props.AlbumTitle
        }
        catch { }

        $pos = 0; $dur = 0; $posAge = -1
        $readAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        try {
            $tl = $s.GetTimelineProperties()
            $pos = [int64]$tl.Position.TotalMilliseconds
            $dur = [int64]$tl.EndTime.TotalMilliseconds
            try {
                # how long ago was this snapshot written
                $posAge = [int64]([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds
            }
            catch { $posAge = -1 }
        }
        catch { }

        # A session that is shutting down can report a playhead in the 10^14
        # range (and status=Closed). Pushing that would put nonsense on screen,
        # so such sessions are never eligible.
        $sane = ($pos -ge 0) -and ($pos -lt $MAX_MS) -and ($dur -lt $MAX_MS)

        $candidates += [pscustomobject]@{
            id       = $id
            title    = $title
            artist   = $artist
            album    = $album
            position = $pos
            duration = $dur
            playing  = $playing
            status   = $status
            sane     = $sane
            posAge   = $posAge
            readAt   = $readAt
        }
    }

    # Score sessions instead of taking the first one. A player can register
    # two sessions for the same track: one real (with duration and a moving
    # position) and one empty shell (0/0 timeline) that still claims Playing.
    # GetSessions() order is not stable across machines, so "first Playing with
    # a title" once picked the empty shell and the progress bar froze at 0.
    # Rank: playing > has title > has a real duration. The real session wins
    # because only it carries a duration.
    foreach ($c in $candidates) {
        $r = 0
        if ($c.status -eq 'Playing') { $r += 100 }
        if ($c.title) { $r += 50 }
        if ($c.duration -gt 1000) { $r += 30 }
        $c | Add-Member -NotePropertyName rank -NotePropertyValue $r -Force
    }

    $usable = @($candidates | Where-Object { $_.sane -and $_.status -ne 'Closed' })
    $pick = $usable | Sort-Object -Property rank -Descending | Select-Object -First 1

    $appliedAge = 0
    if ($pick) {
        $result.active = $true
        $result.title = $pick.title
        $result.artist = $pick.artist
        $result.album = $pick.album
        $result.position = $pick.position
        $result.duration = $pick.duration
        $result.playing = $pick.playing
        $result.player = $pick.id
        $result.positionRaw = $pick.position

        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $result.at = $nowMs

        # Time spent between sampling and serialising counts too.
        $age = $pick.posAge
        if ($age -ge 0) { $age = $age + ($nowMs - $pick.readAt) }

        if ($pick.playing -and $age -ge 0 -and $age -le $MAX_AGE_MS) {
            $result.position = $pick.position + $age
            $appliedAge = $age
        }

        if ($env:NCM_SMTC_DEBUG) {
            $note = "picked=$($pick.id) playing=$($pick.playing) raw=$($pick.position) posAge=$($pick.posAge) readGap=$($nowMs - $pick.readAt) age=$age applied=$appliedAge"
            [Console]::Error.WriteLine('[smTc] ' + $note)
        }
    }
}
catch { }

# positionAgeMs is written last so a debug print never sees a half-updated row.
$result.positionAgeMs = $appliedAge

$result | ConvertTo-Json -Compress
