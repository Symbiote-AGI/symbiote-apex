param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('voices', 'recognizers', 'transcribe', 'synthesize')]
  [string]$Action,
  [string]$InputPath = '',
  [string]$OutputPath = '',
  [string]$AgentName = '',
  [ValidateSet('dictation', 'wake')]
  [string]$Mode = 'dictation'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

if ($Action -eq 'voices') {
  $synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $voices = @($synthesizer.GetInstalledVoices() |
      Where-Object { $_.Enabled } |
      ForEach-Object {
        [pscustomobject]@{
          name = $_.VoiceInfo.Name
          language = $_.VoiceInfo.Culture.Name
          gender = $_.VoiceInfo.Gender.ToString()
        }
      })
    ConvertTo-Json -InputObject $voices -Compress
  }
  finally {
    $synthesizer.Dispose()
  }
  exit 0
}

if ($Action -eq 'recognizers') {
  $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Id } |
    ForEach-Object { $_.Culture.Name })
  ConvertTo-Json -InputObject $recognizers -Compress
  exit 0
}

if (-not $InputPath -or -not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
  throw 'A readable input file is required.'
}

if ($Action -eq 'transcribe') {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new()
  try {
    $culture = $engine.RecognizerInfo.Culture
    if ($Mode -eq 'wake') {
      $normalizedAgentName = ($AgentName -replace '[^\p{L}\p{N}]+', ' ').Trim() -replace '\s+', ' '
      if ([string]::IsNullOrWhiteSpace($normalizedAgentName)) {
        throw 'A valid agent profile name is required for wake-word recognition.'
      }
      $wakeGrammarBuilder = [System.Speech.Recognition.GrammarBuilder]::new()
      $wakeGrammarBuilder.Culture = $culture
      $wakeGrammarBuilder.Append([System.Speech.Recognition.Choices]::new([string[]]@("hey $normalizedAgentName")))
      $wakeGrammar = [System.Speech.Recognition.Grammar]::new($wakeGrammarBuilder)
      $wakeGrammar.Name = 'Symbiant wake phrase'
      $engine.LoadGrammar($wakeGrammar)
    }
    else {
      $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())

      $sendGrammarBuilder = [System.Speech.Recognition.GrammarBuilder]::new()
      $sendGrammarBuilder.Culture = $culture
      $sendGrammarBuilder.AppendDictation()
      $sendGrammarBuilder.Append([System.Speech.Recognition.Choices]::new([string[]]@('send')))
      $sendGrammar = [System.Speech.Recognition.Grammar]::new($sendGrammarBuilder)
      $sendGrammar.Name = 'Dictation with send command'
      $engine.LoadGrammar($sendGrammar)

      $sendOnlyGrammarBuilder = [System.Speech.Recognition.GrammarBuilder]::new()
      $sendOnlyGrammarBuilder.Culture = $culture
      $sendOnlyGrammarBuilder.Append([System.Speech.Recognition.Choices]::new([string[]]@('send')))
      $sendOnlyGrammar = [System.Speech.Recognition.Grammar]::new($sendOnlyGrammarBuilder)
      $sendOnlyGrammar.Name = 'Send command'
      $engine.LoadGrammar($sendOnlyGrammar)
    }

    $engine.SetInputToWaveFile($InputPath)
    $result = $engine.Recognize([TimeSpan]::FromSeconds(60))
    $stopwatch.Stop()
    $text = if ($result) { $result.Text.Trim() } else { '' }
    $duration = if ($result -and $result.Audio) { $result.Audio.Duration.TotalSeconds } else { 0 }
    $confidence = if ($result) { $result.Confidence } else { $null }
    ConvertTo-Json -InputObject ([pscustomobject]@{
      text = $text
      language = $engine.RecognizerInfo.Culture.Name
      duration = $duration
      processingTime = $stopwatch.Elapsed.TotalSeconds
      confidence = $confidence
      grammar = if ($result) { $result.Grammar.Name } else { '' }
      isEmpty = [string]::IsNullOrWhiteSpace($text)
    }) -Compress
  }
  finally {
    $engine.Dispose()
  }
  exit 0
}

if ($Action -eq 'synthesize') {
  if (-not $OutputPath) {
    throw 'An output file is required for speech synthesis.'
  }
  $request = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
  if (-not $request.text -or -not $request.voice) {
    throw 'Speech text and a voice are required.'
  }

  $synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $availableVoices = @($synthesizer.GetInstalledVoices() |
      Where-Object { $_.Enabled } |
      ForEach-Object { $_.VoiceInfo.Name })
    if ($availableVoices -notcontains [string]$request.voice) {
      throw "The selected Windows voice is not installed: $($request.voice)"
    }

    $ratePercent = [int][Math]::Round(([double]$request.rate - 1) * 100)
    $pitchPercent = [int][Math]::Round(([double]$request.pitch - 1) * 100)
    $volumePercent = [int][Math]::Round([double]$request.volume * 100)
    $rateText = if ($ratePercent -gt 0) { "+$ratePercent%" } else { "$ratePercent%" }
    $pitchText = if ($pitchPercent -gt 0) { "+$pitchPercent%" } else { "$pitchPercent%" }
    $escapedText = [System.Security.SecurityElement]::Escape([string]$request.text)
    $escapedVoice = [System.Security.SecurityElement]::Escape([string]$request.voice)
    $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='$escapedVoice'><prosody rate='$rateText' pitch='$pitchText' volume='$volumePercent%'>$escapedText</prosody></voice></speak>"
    $synthesizer.SetOutputToWaveFile($OutputPath)
    $synthesizer.SpeakSsml($ssml)
  }
  finally {
    $synthesizer.Dispose()
  }
}
