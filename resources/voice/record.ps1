# Records the default microphone to a WAV file with the Windows MCI API (no extra software needed).
# Protocol: prints READY once recording has started, then waits for one line on stdin:
#   "save"   -> stops and writes the WAV to -Out, prints SAVED
#   anything else / EOF -> stops and discards, prints CANCELLED
param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace ApexDev -Name Mci -MemberDefinition @'
[DllImport("winmm.dll", CharSet = CharSet.Unicode)]
public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, IntPtr hwndCallback);
[DllImport("winmm.dll", CharSet = CharSet.Unicode)]
public static extern bool mciGetErrorString(int error, System.Text.StringBuilder buffer, int bufferSize);
'@

function Invoke-Mci([string]$Command) {
  $code = [ApexDev.Mci]::mciSendString($Command, $null, 0, [IntPtr]::Zero)
  if ($code -ne 0) {
    $text = New-Object System.Text.StringBuilder 256
    [void][ApexDev.Mci]::mciGetErrorString($code, $text, 256)
    throw "MCI error $code on '$($Command.Split(' ')[0])': $($text.ToString())"
  }
}

try {
  Invoke-Mci 'open new type waveaudio alias apexrec'
  # 16 kHz mono 16-bit keeps files small and is what speech models expect.
  Invoke-Mci 'set apexrec bitspersample 16 samplespersec 16000 channels 1 bytespersec 32000 alignment 2'
  Invoke-Mci 'record apexrec'
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()

  $line = [Console]::In.ReadLine()
  Invoke-Mci 'stop apexrec'
  if ($line -eq 'save') {
    Invoke-Mci ('save apexrec "{0}"' -f $Out)
    [Console]::Out.WriteLine('SAVED')
  } else {
    [Console]::Out.WriteLine('CANCELLED')
  }
} catch {
  [Console]::Out.WriteLine("ERROR $($_.Exception.Message)")
  exit 1
} finally {
  [void][ApexDev.Mci]::mciSendString('close apexrec', $null, 0, [IntPtr]::Zero)
  [Console]::Out.Flush()
}
