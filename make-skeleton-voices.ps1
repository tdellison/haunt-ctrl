# Generates test voice files for the Skeleton zone using Windows built-in TTS.
# Creates Desktop\SKELETON\skeleton-left.wav and skeleton-right.wav with two different voices.
Add-Type -AssemblyName System.Speech

$dir = "$env:USERPROFILE\OneDrive\Desktop\SKELETON"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
Write-Host "Installed voices: $($voices -join ', ')"

# LEFT skeleton — male voice, slow and low
$male = $voices | Where-Object { $_ -match 'David' } | Select-Object -First 1
if (-not $male) { $male = $voices[0] }
$synth.SelectVoice($male)
$synth.Rate = -3
$synth.SetOutputToWaveFile("$dir\skeleton-left.wav")
$synth.Speak("Well well well... another visitor. I used to have skin in this game... now I'm just bones. Stick around... we're dying for company.")
$synth.SetOutputToNull()

# RIGHT skeleton — different voice, faster and snappier
$alt = $voices | Where-Object { $_ -match 'Zira|Mark' } | Select-Object -First 1
if (-not $alt) { $alt = $voices[-1] }
$synth.SelectVoice($alt)
$synth.Rate = -1
$synth.SetOutputToWaveFile("$dir\skeleton-right.wav")
$synth.Speak("Don't listen to him, he's all talk and no body! Ha! Get it? No body? ... Tough crowd. We haven't had a good laugh here in centuries.")
$synth.SetOutputToNull()

$synth.Dispose()
Write-Host ""
Write-Host "Done! Created:"
Write-Host "  $dir\skeleton-left.wav"
Write-Host "  $dir\skeleton-right.wav"
