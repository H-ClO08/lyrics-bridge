<#
    NCM NowPlaying - SMTC bridge
    ------------------------------------------------------------------
    Publishes the current phone playback as a Windows media session
    (Global System Media Transport Controls) so desktop lyrics apps
    such as BetterLyrics can pick it up and render lyrics themselves.

    How it works
      1. requests an explicit AppUserModelID so the media session shows
         up as "NCMPhoneBridge" instead of "powershell.exe"
      2. creates a MediaPlayer playing a silent WAV, which is what
         registers a real SMTC session (there is no way to register one
         from a script without an underlying media player)
      3. polls the local NCM NowPlaying service and mirrors
         title / artist / album / cover / duration / position into it

    Why the silent WAV is regenerated per song
      A MediaPlayer continuously republishes ITS OWN timeline into SMTC,
      so calling UpdateTimelineProperties by hand gets overwritten
      within a second. Fighting that is hopeless. Instead we hand the
      player a silent WAV whose duration equals the song's duration and
      simply seek it - then the player's own timeline is already the
      correct one, and no fighting is needed. Play/pause is mirrored to
      the player for the same reason.

    No installation and no compiler required: Windows PowerShell 5.1
    can project WinRT types directly.

    Usage:
        powershell -ExecutionPolicy Bypass -File smtc-bridge.ps1
        powershell -ExecutionPolicy Bypass -File smtc-bridge.ps1 -Server http://127.0.0.1:8787
        powershell -ExecutionPolicy Bypass -File smtc-bridge.ps1 -DryRun

    NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1
    decodes .ps1 files using the ANSI code page unless they carry a BOM,
    so non-ASCII characters here would be garbled on Chinese Windows.
#>

[CmdletBinding()]
param(
    [string]$Server = 'http://127.0.0.1:8787',
    [int]$IntervalMs = 1000,
    [string]$AppId = 'NCMPhoneBridge',
    [int]$ResyncThresholdMs = 2500,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Emit UTF-8 so that callers capturing our output do not get the system ANSI code page.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:TempDir = Join-Path $env:TEMP 'ncm-nowplaying-smtc'
if (-not (Test-Path $script:TempDir)) { New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Color)
    $ts = (Get-Date).ToString('HH:mm:ss')
    if ($Color) { Write-Host "[$ts] $Message" -ForegroundColor $Color }
    else { Write-Host "[$ts] $Message" }
}

# ---------------------------------------------------------------------------
# WinRT plumbing
# ---------------------------------------------------------------------------

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtOperation, $ResultType) {
    $method = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
    $task = $method.Invoke($null, @($WinRtOperation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$T = @{
    MediaPlayer = [Windows.Media.Playback.MediaPlayer, Windows.Media, ContentType = WindowsRuntime]
    MediaSource = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
    PlayType    = [Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime]
    AudioCat    = [Windows.Media.Playback.MediaPlayerAudioCategory, Windows.Media.Playback, ContentType = WindowsRuntime]
    Timeline    = [Windows.Media.SystemMediaTransportControlsTimelineProperties, Windows.Media, ContentType = WindowsRuntime]
    InMemStream = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    DataWriter  = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
    StreamRef   = [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]
}

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

function Get-Json {
    param([string]$Url, [int]$TimeoutMs = 2500)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    try {
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
        return ($text | ConvertFrom-Json)
    }
    finally { $req.Abort() }
}

function Get-ImageBytes {
    param([string]$Url, [int]$TimeoutMs = 8000)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    try {
        $resp = $req.GetResponse()
        $ms = New-Object System.IO.MemoryStream
        $resp.GetResponseStream().CopyTo($ms)
        $resp.Close()
        return $ms.ToArray()
    }
    finally { $req.Abort() }
}

# ---------------------------------------------------------------------------
# silent WAV generator
# ---------------------------------------------------------------------------

# 8 kHz / 8 bit / mono = 8 KB per second, so even a 10 minute track is ~4.7 MB.
function Write-SilentWav {
    param([string]$Path, [int]$Seconds)

    $sampleRate = 8000
    $channels = 1
    $bitsPerSample = 8
    $blockAlign = $channels * ($bitsPerSample / 8)
    $dataLen = [int]($sampleRate * $Seconds * $blockAlign)

    $header = New-Object byte[] 44
    $ascii = [System.Text.Encoding]::ASCII
    $ascii.GetBytes('RIFF').CopyTo($header, 0)
    [BitConverter]::GetBytes([uint32](36 + $dataLen)).CopyTo($header, 4)
    $ascii.GetBytes('WAVE').CopyTo($header, 8)
    $ascii.GetBytes('fmt ').CopyTo($header, 12)
    [BitConverter]::GetBytes([uint32]16).CopyTo($header, 16)
    [BitConverter]::GetBytes([uint16]1).CopyTo($header, 20)          # PCM
    [BitConverter]::GetBytes([uint16]$channels).CopyTo($header, 22)
    [BitConverter]::GetBytes([uint32]$sampleRate).CopyTo($header, 24)
    [BitConverter]::GetBytes([uint32]($sampleRate * $blockAlign)).CopyTo($header, 28)
    [BitConverter]::GetBytes([uint16]$blockAlign).CopyTo($header, 32)
    [BitConverter]::GetBytes([uint16]$bitsPerSample).CopyTo($header, 34)
    $ascii.GetBytes('data').CopyTo($header, 36)
    [BitConverter]::GetBytes([uint32]$dataLen).CopyTo($header, 40)

    # 8 bit PCM silence is 0x80, not 0x00
    $block = New-Object byte[] 65536
    for ($i = 0; $i -lt $block.Length; $i++) { $block[$i] = 0x80 }

    $fs = [System.IO.File]::Create($Path)
    try {
        $fs.Write($header, 0, 44)
        $written = 0
        while ($written -lt $dataLen) {
            $n = [math]::Min($block.Length, $dataLen - $written)
            $fs.Write($block, 0, $n)
            $written += $n
        }
    }
    finally { $fs.Close() }

    return $Path
}

# ---------------------------------------------------------------------------
# album art -> SMTC thumbnail (the stream must stay referenced or GC kills it)
# ---------------------------------------------------------------------------

$script:ThumbStreams = New-Object System.Collections.ArrayList

function Set-AlbumArt {
    param($Smtc, [byte[]]$Bytes)
    $stream = [Activator]::CreateInstance($T.InMemStream)
    $writer = [Activator]::CreateInstance($T.DataWriter, @($stream))
    $writer.WriteBytes($Bytes)
    Await ($writer.StoreAsync()) ([uint32]) | Out-Null
    $writer.DetachStream() | Out-Null
    $writer.Dispose()
    $stream.Seek(0)
    $Smtc.DisplayUpdater.Thumbnail = $T.StreamRef::CreateFromStream($stream)
    $Smtc.DisplayUpdater.Update()

    $script:ThumbStreams.Add($stream) | Out-Null
    while ($script:ThumbStreams.Count -gt 3) {
        try { $script:ThumbStreams[0].Dispose() } catch { }
        $script:ThumbStreams.RemoveAt(0)
    }
}

function Set-TrackMetadata {
    param($Smtc, $Track)
    $props = $Smtc.DisplayUpdater.MusicProperties
    $props.Title = [string]$Track.title
    $props.Artist = [string]$Track.artist
    $props.AlbumTitle = [string]$Track.album
    $Smtc.DisplayUpdater.Update()
}

# ---------------------------------------------------------------------------
# startup
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=================================================='
Write-Host '  NCM NowPlaying -> Windows media session (SMTC)'
Write-Host '=================================================='
Write-Host "  service : $Server"
Write-Host "  app id  : $AppId"
Write-Host "  poll    : ${IntervalMs}ms"
Write-Host "  temp    : $script:TempDir"
Write-Host ''

# The AUMID must be set before any audio session exists, otherwise the media
# session gets attributed to powershell.exe.
try {
    Add-Type -Namespace NcmBridge -Name Shell32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode, PreserveSig = false)]
public static extern void SetCurrentProcessExplicitAppUserModelID([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string AppID);
'@
    [NcmBridge.Shell32]::SetCurrentProcessExplicitAppUserModelID($AppId)
    Write-Host '  app id applied'
}
catch {
    Write-Host '  [warn] could not set app id, the session will show as powershell.exe'
    Write-Host "         $($_.Exception.Message)"
}

if ($DryRun) {
    Write-Host ''
    Write-Host '  dry run: polling only, no media session will be created'
    Write-Host ''
    while ($true) {
        try {
            $np = Get-Json "$Server/api/nowplaying"
            if ($np.active) {
                Write-Host ("[{0}] {1} - {2}  {3:N0}/{4:N0}ms  playing={5}" -f (Get-Date -Format HH:mm:ss), $np.title, $np.artist, $np.positionMs, $np.durationMs, $np.playing)
            }
            else {
                Write-Host ("[{0}] (idle) status={1}" -f (Get-Date -Format HH:mm:ss), $np.status)
            }
        }
        catch {
            Write-Host ("[{0}] service unreachable: {1}" -f (Get-Date -Format HH:mm:ss), $_.Exception.Message)
        }
        Start-Sleep -Milliseconds $IntervalMs
    }
}

# Only one instance may run. Two bridges means two SMTC sessions sharing the same
# session id, which makes a lyrics app flip between them and log every change twice.
$singleInstance = New-Object System.Threading.Mutex($false, 'NCMPhoneBridge_SingleInstance')
if (-not $singleInstance.WaitOne(0)) {
    Write-Host ''
    Write-Host '  [stop] Another NCMPhoneBridge is already running.' -ForegroundColor Yellow
    Write-Host '         Two bridges would publish two media sessions with the same id,'
    Write-Host '         which makes lyrics apps flicker and log everything twice.'
    Write-Host '         Close the other window first (or kill the other process).'
    Write-Host ''
    exit 1
}

$player = [Activator]::CreateInstance($T.MediaPlayer)
$player.Volume = 0
$player.IsLoopingEnabled = $false
try { $player.AudioCategory = $T.AudioCat::Other } catch { }

$smtc = $player.SystemMediaTransportControls
$smtc.IsEnabled = $true
$smtc.DisplayUpdater.Type = $T.PlayType::Music

$script:WavSeq = 0
$script:LoadedDurationMs = 0
$script:LoadedKey = ''

function Set-Source {
    param($Player, [double]$DurationMs)

    $script:WavSeq++
    $secs = [int][math]::Ceiling($DurationMs / 1000.0)
    if ($secs -lt 30) { $secs = 30 }
    if ($secs -gt 7200) { $secs = 7200 }        # cap at 2 hours

    $path = Join-Path $script:TempDir ("silence-{0}.wav" -f $script:WavSeq)
    Write-SilentWav -Path $path -Seconds $secs | Out-Null

    $Player.Source = $T.MediaSource::CreateFromUri((New-Object System.Uri($path)))
    $script:LoadedDurationMs = $secs * 1000

    # drop older wavs (the player may still hold the previous one open)
    Get-ChildItem $script:TempDir -Filter 'silence-*.wav' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne (Split-Path $path -Leaf) } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }

    return $path
}

Set-Source -Player $player -DurationMs 60000 | Out-Null
$player.Play()
Start-Sleep -Milliseconds 600

Write-Host '  media session created - BetterLyrics should now list'
Write-Host '  "NCMPhoneBridge" as a playback source automatically.'
Write-Host ''

$idleShown = $false
$failCount = 0
$coverCache = @{}
$script:MetaTicksLeft = 0
$script:CurrentCover = $null
$script:MockWarned = $false
$timeline = [Activator]::CreateInstance($T.Timeline)

try {
    while ($true) {
        $np = $null
        try {
            $np = Get-Json "$Server/api/nowplaying"
            $failCount = 0
        }
        catch {
            $failCount++
            if ($failCount -eq 1 -or ($failCount % 60) -eq 0) {
                Write-Log "cannot reach $Server ($failCount consecutive failures)" 'Yellow'
            }
            Start-Sleep -Milliseconds $IntervalMs
            continue
        }

        # ---------------- demo-mode guard ----------------
        # Being fooled by the demo playlist is the single most confusing failure mode:
        # the phone is playing, but everything on screen comes from a fake list.
        if ($np.source -eq 'mock') {
            if (-not $script:MockWarned) {
                $script:MockWarned = $true
                Write-Log '**************************************************' 'Yellow'
                Write-Log 'WARNING: the service is in DEMO mode (mock).' 'Yellow'
                Write-Log 'It is NOT reading your phone. Everything you see comes' 'Yellow'
                Write-Log 'from a built-in fake playlist.' 'Yellow'
                Write-Log 'Close the demo window and start start.bat instead.' 'Yellow'
                Write-Log '**************************************************' 'Yellow'
            }
        }
        else {
            $script:MockWarned = $false
        }

        # ---------------- idle ----------------
        if (-not $np.active) {
            if (-not $idleShown) {
                $idleShown = $true
                Write-Log 'idle - waiting for the phone to play something'
                try {
                    $props = $smtc.DisplayUpdater.MusicProperties
                    $props.Title = 'NCM Phone Bridge'
                    $props.Artist = 'waiting for phone playback'
                    $props.AlbumTitle = ''
                    $smtc.DisplayUpdater.Update()
                }
                catch { }
                try { $player.Pause() } catch { }
                # Reset the track marker. Without this, resuming the SAME song
                # would look like "no change" and the placeholder metadata above
                # would never be replaced.
                $script:LoadedKey = ''
            }
            Start-Sleep -Milliseconds $IntervalMs
            continue
        }
        $idleShown = $false

        $posMs = [double]$np.positionMs
        $durMs = [double]$np.durationMs
        if ($durMs -le 0) { $durMs = $posMs + 60000 }

        # ---------------- song change (identity only, NOT duration/songId) ----------------
        # Both duration and songId are unstable right after a switch: duration is the
        # previous track's value until it settles, and songId only arrives after the
        # server finishes matching (which is async). Keying on them re-triggers
        # Set-Source and wipes the cover repeatedly. title|artist come straight from
        # the phone's MediaSession metadata and are stable from the very first tick.
        $trackKey = "$($np.title)|$($np.artist)"
        if ($trackKey -ne $script:LoadedKey) {
            $script:LoadedKey = $trackKey
            Write-Log "now playing: $($np.title) - $($np.artist)  [$([int]($durMs/1000))s]"

            # Change the source FIRST, then write metadata: swapping the source
            # makes the player drop its own SMTC metadata.
            Set-Source -Player $player -DurationMs $durMs | Out-Null

            try { Set-TrackMetadata -Smtc $smtc -Track $np }
            catch { Write-Log "[warn] metadata failed: $($_.Exception.Message)" 'Yellow' }

            # Setting Source loads asynchronously, and the load completion wipes BOTH the
            # metadata and the thumbnail. Re-assert them on the next ticks, once the load
            # has settled (cover is re-applied only once, to avoid stream churn).
            $script:MetaTicksLeft = 5
            $script:CurrentCover = $null

            try { $player.PlaybackSession.Position = [TimeSpan]::FromMilliseconds($posMs) } catch { }
            if ($np.playing) { try { $player.Play() } catch { } } else { try { $player.Pause() } catch { } }

            if ($np.cover) {
                $coverUrl = "$Server/api/cover?url=" + [uri]::EscapeDataString([string]$np.cover)
                try {
                    if (-not $coverCache.ContainsKey($coverUrl)) {
                        $coverCache[$coverUrl] = Get-ImageBytes $coverUrl
                        if ($coverCache.Count -gt 6) { $coverCache.Remove(($coverCache.Keys | Select-Object -First 1)) }
                    }
                    $script:CurrentCover = $coverCache[$coverUrl]
                    Set-AlbumArt -Smtc $smtc -Bytes $script:CurrentCover
                }
                catch { Write-Log "[warn] cover failed: $($_.Exception.Message)" 'Yellow' }
            }
        }

        # ---------------- duration correction (silent WAV length only) ----------------
        # Once duration settles (e.g. 60s -> 300s) the silent track must be long enough
        # to seek into. Song identity did not change, so reuse the cached cover instead
        # of re-downloading.
        $effDur = $durMs
        if ($effDur -lt 30000) { $effDur = 30000 }
        if ($effDur -gt 7200000) { $effDur = 7200000 }
        if ([math]::Abs($effDur - $script:LoadedDurationMs) -gt 3000) {
            Set-Source -Player $player -DurationMs $durMs | Out-Null
            try { Set-TrackMetadata -Smtc $smtc -Track $np } catch { }
            $script:MetaTicksLeft = 5
            if ($script:CurrentCover) {
                try { Set-AlbumArt -Smtc $smtc -Bytes $script:CurrentCover } catch { }
            }
            try { $player.PlaybackSession.Position = [TimeSpan]::FromMilliseconds($posMs) } catch { }
        }
        # ---------------- re-assert metadata / cover after a source swap ----------------
        # Re-assert the cover on EVERY tick, not just the last one: the async source
        # load wipes the thumbnail at an unpredictable moment, and BetterLyrics reads
        # it on its own ~1s debounce. Repeated re-asserts shrink the empty window so
        # the next BetterLyrics read sees the restored cover.
        if ($script:MetaTicksLeft -gt 0) {
            $script:MetaTicksLeft--
            try { Set-TrackMetadata -Smtc $smtc -Track $np }
            catch { }
            if ($script:CurrentCover) {
                try { Set-AlbumArt -Smtc $smtc -Bytes $script:CurrentCover } catch { }
            }
        }

        # ---------------- keep the player in phase (runs every tick) ----------------
        # The player owns the SMTC timeline, so the only way to move it is to move the
        # player. A paused MediaPlayer IGNORES Position changes (measured), so a pause
        # is always preceded by a seek; while paused nothing competes with us, so the
        # timeline can safely be written by hand.
        try {
            $session = $player.PlaybackSession
            $state = [string]$session.PlaybackState

            if ($np.playing) {
                if ($state -ne 'Playing') {
                    $player.Play()
                    # resuming continues from where the player was left, so re-align
                    $session.Position = [TimeSpan]::FromMilliseconds($posMs)
                }
                elseif ([math]::Abs($session.Position.TotalMilliseconds - $posMs) -gt $ResyncThresholdMs) {
                    $session.Position = [TimeSpan]::FromMilliseconds($posMs)
                }
            }
            else {
                if ($state -eq 'Playing') {
                    $session.Position = [TimeSpan]::FromMilliseconds($posMs)
                    $player.Pause()
                }
                $timeline.StartTime = [TimeSpan]::FromSeconds(0)
                $timeline.EndTime = [TimeSpan]::FromMilliseconds($durMs)
                $timeline.Position = [TimeSpan]::FromMilliseconds($posMs)
                $timeline.MinSeekTime = [TimeSpan]::FromSeconds(0)
                $timeline.MaxSeekTime = [TimeSpan]::FromMilliseconds($durMs)
                $smtc.UpdateTimelineProperties($timeline)
            }
        }
        catch { }

        Start-Sleep -Milliseconds $IntervalMs
    }
}
finally {
    Write-Host ''
    Write-Host '  shutting down media session...'
    try { $player.Dispose() } catch { }
    Get-ChildItem $script:TempDir -Filter 'silence-*.wav' -ErrorAction SilentlyContinue |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }
    try { $singleInstance.ReleaseMutex() } catch { }
    try { $singleInstance.Dispose() } catch { }
}
