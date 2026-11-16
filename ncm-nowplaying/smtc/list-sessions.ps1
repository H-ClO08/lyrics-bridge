<#
    NCM NowPlaying - list Windows media sessions (SMTC)
    ------------------------------------------------------------------
    Read-only diagnostic. Shows every Global System Media Transport
    Controls session Windows currently knows about, with the exact
    fields a lyrics app like BetterLyrics reads:
        session id, title, artist, album, cover presence, timeline

    Use it to confirm that the SMTC bridge is publishing correctly:

        powershell -ExecutionPolicy Bypass -File list-sessions.ps1

    ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI
    unless the file has a BOM).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Force UTF-8 output. By default Write-Host going into a pipe uses the system ANSI
# code page (GBK on Chinese Windows), so callers decoding as UTF-8 get mojibake.
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

$T = @{
    DataReader = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
}

$mgr = Await ($mgrT::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = @($mgr.GetSessions())

Write-Host ''
Write-Host "Windows media sessions: $($sessions.Count)"
Write-Host ('=' * 74)

$index = 0
foreach ($s in $sessions) {
    $index++
    Write-Host ""
    Write-Host "[$index] session id : $($s.SourceAppUserModelId)"

    try {
        $props = Await ($s.TryGetMediaPropertiesAsync()) ($propsT)
        Write-Host "    title        : $($props.Title)"
        Write-Host "    artist       : $($props.Artist)"
        Write-Host "    album        : $($props.AlbumTitle)"

        $genres = @($props.Genres)
        if ($genres.Count -gt 0) { Write-Host "    genres       : $($genres -join ', ')" }

        if ($null -ne $props.Thumbnail) {
            try {
                $rs = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                # Read through a DataReader: the projected COM object does not expose
                # Size / AsStreamForRead in a way PowerShell 5.1 can bind to.
                $reader = [Activator]::CreateInstance($T.DataReader, @($rs))
                $size = Await ($reader.LoadAsync([uint32]4194304)) ([uint32])
                $bytes = New-Object byte[] ([int]$size)
                $reader.ReadBytes($bytes)
                $reader.Dispose()

                $kind = 'unknown'
                if ($size -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $kind = 'jpeg' }
                elseif ($size -ge 4 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $kind = 'png' }
                Write-Host "    cover        : yes, $size bytes, $kind"
            }
            catch {
                Write-Host "    cover        : present but unreadable ($($_.Exception.Message))"
            }
        }
        else {
            Write-Host "    cover        : none"
        }
    }
    catch {
        Write-Host "    metadata     : unavailable ($($_.Exception.Message))"
    }

    try {
        $tl = $s.GetTimelineProperties()
        $pos = [math]::Round($tl.Position.TotalSeconds, 1)
        $dur = [math]::Round($tl.EndTime.TotalSeconds, 1)
        Write-Host "    position     : ${pos}s / ${dur}s"
    }
    catch { }

    try {
        $pb = $s.GetPlaybackInfo()
        Write-Host "    playback     : $($pb.PlaybackStatus)"
    }
    catch { }
}

Write-Host ''
