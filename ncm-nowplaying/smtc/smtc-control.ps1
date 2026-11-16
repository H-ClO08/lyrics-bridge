<#
    NCM NowPlaying - send a media command to the PC's current session
    -----------------------------------------------------------------
    The lyrics page is a remote control for whatever is playing on THIS PC.
    Windows exposes that through SMTC:

        TrySkipNextAsync() / TrySkipPreviousAsync()
        TryTogglePlayPauseAsync() / TryPlayAsync() / TryPauseAsync()

    Those return IAsyncOperation<Boolean>: true = the player accepted it.
    A paused player still accepts skip; a browser tab without a playlist
    usually refuses "next" -- that comes back as ok:false, which the page
    turns into a small toast instead of pretending it worked.

    Output (stdout, single-line JSON). Error strings are ASCII CODES, not
    sentences: src/control.js turns them into user-facing text, so this file
    can stay pure ASCII (see the note at the bottom).

        {"ok":true,"action":"next","session":"cloudmusic.exe",
         "title":"...","code":""}

        code: "" | "no-manager" | "no-session" | "not-supported" | "exception"

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on
    a Chinese Windows) unless the file has a BOM. A UTF-8 Chinese string then
    decodes to garbage bytes and can swallow the closing quote -- the whole
    script dies with a confusing "string is missing the terminator" error.
    Keep every comment and string here in plain English/ASCII.
#>

[CmdletBinding()]
param(
    [ValidateSet('next', 'prev', 'toggle', 'play', 'pause')]
    [string]$Action = 'toggle'
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
$MAX_MS = 86400000

function Out-Result($obj) {
    $obj | ConvertTo-Json -Compress
    exit 0
}

try {
    $mgr = Await ($mgrT::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $sessions = @($mgr.GetSessions())
}
catch {
    Out-Result ([pscustomobject]@{ ok = $false; action = $Action; code = 'no-manager'; error = $_.Exception.Message })
}

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
        session = $s
        id      = $id
        title   = $title
        status  = $status
        sane    = $sane
    }
}

# Same picking rules as read-smtc-json.ps1, so the page controls exactly the
# session it is showing.
$usable = @($candidates | Where-Object { $_.sane -and $_.status -ne 'Closed' })
$pick = $usable | Where-Object { $_.status -eq 'Playing' -and $_.title } | Select-Object -First 1
if (-not $pick) { $pick = $usable | Where-Object { $_.title } | Select-Object -First 1 }

if (-not $pick) {
    Out-Result ([pscustomobject]@{ ok = $false; action = $Action; code = 'no-session'; error = '' })
}

$ok = $false
$code = ''
$detail = ''
try {
    switch ($Action) {
        'next' { $ok = Await ($pick.session.TrySkipNextAsync()) ([bool]) }
        'prev' { $ok = Await ($pick.session.TrySkipPreviousAsync()) ([bool]) }
        'toggle' { $ok = Await ($pick.session.TryTogglePlayPauseAsync()) ([bool]) }
        'play' { $ok = Await ($pick.session.TryPlayAsync()) ([bool]) }
        'pause' { $ok = Await ($pick.session.TryPauseAsync()) ([bool]) }
    }
}
catch {
    $code = 'exception'
    $detail = $_.Exception.Message
}

if (-not $ok -and -not $code) { $code = 'not-supported' }

Out-Result ([pscustomobject]@{
        ok      = [bool]$ok
        action  = $Action
        session = $pick.id
        title   = $pick.title
        code    = $code
        error   = $detail
    })
