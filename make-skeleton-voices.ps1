# Generates test voice files for the Skeleton zone using Windows built-in TTS.
# Output is STEREO with the voice panned hard to one side:
#   skeleton-left.wav  -> voice only in LEFT channel  (FL speaker)
#   skeleton-right.wav -> voice only in RIGHT channel (FR speaker)
Add-Type -AssemblyName System.Speech

$dir = "$env:USERPROFILE\OneDrive\Desktop\SKELETON"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Convert a mono 16-bit PCM wav into stereo with audio on only one channel
function ConvertTo-PannedStereo([string]$monoPath, [string]$outPath, [string]$side) {
  $bytes = [System.IO.File]::ReadAllBytes($monoPath)
  # Locate the 'data' chunk
  $dataPos = -1
  for ($i = 12; $i -lt $bytes.Length - 8; $i++) {
    if ($bytes[$i] -eq 0x64 -and $bytes[$i+1] -eq 0x61 -and $bytes[$i+2] -eq 0x74 -and $bytes[$i+3] -eq 0x61) { $dataPos = $i; break }
  }
  if ($dataPos -lt 0) { throw "data chunk not found in $monoPath" }
  $dataLen  = [BitConverter]::ToInt32($bytes, $dataPos + 4)
  $dataStart = $dataPos + 8
  $sampleRate = [BitConverter]::ToInt32($bytes, 24)

  $numSamples = [int]($dataLen / 2)
  $outData = New-Object byte[] ($numSamples * 4)
  for ($s = 0; $s -lt $numSamples; $s++) {
    $lo = $bytes[$dataStart + $s*2]
    $hi = $bytes[$dataStart + $s*2 + 1]
    if ($side -eq 'left') {
      $outData[$s*4]     = $lo; $outData[$s*4 + 1] = $hi   # L = voice
      $outData[$s*4 + 2] = 0;  $outData[$s*4 + 3] = 0      # R = silent
    } else {
      $outData[$s*4]     = 0;  $outData[$s*4 + 1] = 0      # L = silent
      $outData[$s*4 + 2] = $lo; $outData[$s*4 + 3] = $hi   # R = voice
    }
  }

  $ms = New-Object System.IO.MemoryStream
  $w  = New-Object System.IO.BinaryWriter($ms)
  $w.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $w.Write([int](36 + $outData.Length))
  $w.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
  $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]2)          # PCM, stereo
  $w.Write([int]$sampleRate); $w.Write([int]($sampleRate * 4))       # byte rate
  $w.Write([int16]4); $w.Write([int16]16)                            # block align, bits
  $w.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
  $w.Write([int]$outData.Length)
  $w.Write($outData)
  [System.IO.File]::WriteAllBytes($outPath, $ms.ToArray())
  $w.Dispose(); $ms.Dispose()
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
Write-Host "Installed voices: $($voices -join ', ')"
$tmp = "$env:TEMP\skel-mono.wav"

# LEFT skeleton — male voice, slow and low, LEFT channel only
$male = $voices | Where-Object { $_ -match 'David' } | Select-Object -First 1
if (-not $male) { $male = $voices[0] }
$synth.SelectVoice($male)
$synth.Rate = -3
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($tmp, $fmt)
$synth.Speak("Testing testing... left side here. I'm the skeleton on the left. If you hear me anywhere else... we have a problem.")
$synth.SetOutputToNull()
ConvertTo-PannedStereo $tmp "$dir\skeleton-left.wav" 'left'

# RIGHT skeleton — different voice, RIGHT channel only
$alt = $voices | Where-Object { $_ -match 'Zira|Mark' } | Select-Object -First 1
if (-not $alt) { $alt = $voices[-1] }
$synth.SelectVoice($alt)
$synth.Rate = -1
$synth.SetOutputToWaveFile($tmp, $fmt)
$synth.Speak("And I'm the right side! Right speaker, right skeleton, right now. If I'm coming out of the left speaker, swap those wires!")
$synth.SetOutputToNull()
ConvertTo-PannedStereo $tmp "$dir\skeleton-right.wav" 'right'

# ── Witch test voices (Witch 1 = RIGHT speaker w/ future mic, Witch 2 = LEFT) ──
# Only generated if not already present, so your own files won't be overwritten.
$wdir = "$env:USERPROFILE\OneDrive\Desktop\WITCH"
New-Item -ItemType Directory -Force -Path $wdir | Out-Null

if (-not (Test-Path "$wdir\witch1-right.wav")) {
  $f = $voices | Where-Object { $_ -match 'Zira' } | Select-Object -First 1
  if (-not $f) { $f = $voices[-1] }
  $synth.SelectVoice($f)
  $synth.Rate = -2
  $synth.SetOutputToWaveFile($tmp, $fmt)
  $synth.Speak("Witch one, on the right. I am the main witch... soon I shall hear your every word. Right speaker, right side of the cauldron.")
  $synth.SetOutputToNull()
  ConvertTo-PannedStereo $tmp "$wdir\witch1-right.wav" 'right'
  Write-Host "Created $wdir\witch1-right.wav"
}
if (-not (Test-Path "$wdir\witch2-left.wav")) {
  $f2 = $voices | Where-Object { $_ -match 'David|Mark' } | Select-Object -First 1
  if (-not $f2) { $f2 = $voices[0] }
  $synth.SelectVoice($f2)
  $synth.Rate = -3
  $synth.SetOutputToWaveFile($tmp, $fmt)
  $synth.Speak("And I am witch two, cackling from the left. If you hear me on the right side, our brooms are crossed.")
  $synth.SetOutputToNull()
  ConvertTo-PannedStereo $tmp "$wdir\witch2-left.wav" 'left'
  Write-Host "Created $wdir\witch2-left.wav"
}

$synth.Dispose()
Remove-Item $tmp -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done! Created stereo-panned test files:"
Write-Host "  $dir\skeleton-left.wav   (voice in LEFT channel only)"
Write-Host "  $dir\skeleton-right.wav  (voice in RIGHT channel only)"
Write-Host "  plus witch1-right.wav / witch2-left.wav in the WITCH folder (if not already present)"
