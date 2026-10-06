[CmdletBinding()]
param(
    [ValidateRange(1, 30)][int]$ConnectTimeoutSeconds = 5,
    [ValidateRange(1, 60)][int]$RequestTimeoutSeconds = 12,
    [ValidateRange(100, 10000)][int]$TcpTimeoutMilliseconds = 3000
)

# Read-only public requests. No cookies, account data, login, or POST requests.
# Output is JSON on stdout; no files or response bodies are saved by this script.
$ErrorActionPreference = 'Stop'
$curlCommand = Get-Command curl.exe -ErrorAction Stop
$targetUrls = @(
    'https://dxscxcy.hzau.edu.cn/CXCY/HZAU',
    'http://dxscxcy.hzau.edu.cn/CXCY/HZAU',
    'https://portal-paas.hzau.edu.cn/main.html',
    'http://portal-paas.hzau.edu.cn/main.html',
    'https://www.hzau.edu.cn/',
    'http://www.hzau.edu.cn/'
)

function Get-PublicDnsRecord([string]$TargetHost) {
    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses($TargetHost) | ForEach-Object { $_.IPAddressToString })
        return [pscustomobject]@{ host = $TargetHost; success = ($addresses.Count -gt 0); addresses = $addresses; error = $null }
    } catch {
        return [pscustomobject]@{ host = $TargetHost; success = $false; addresses = @(); error = $_.Exception.GetBaseException().Message }
    }
}

function Test-PublicTcpPort([string]$TargetHost, [int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $task = $client.ConnectAsync($TargetHost, $Port)
        $completed = $task.Wait($TcpTimeoutMilliseconds)
        if (-not $completed) { throw [System.TimeoutException]::new('TCP connect timed out') }
        return [pscustomobject]@{ host = $TargetHost; port = $Port; success = $client.Connected; elapsedMs = $stopwatch.ElapsedMilliseconds; error = $null }
    } catch {
        return [pscustomobject]@{ host = $TargetHost; port = $Port; success = $false; elapsedMs = $stopwatch.ElapsedMilliseconds; error = $_.Exception.GetBaseException().Message }
    } finally {
        $client.Dispose()
    }
}

function Invoke-PublicRequest([string]$Url, [string]$Method) {
    $marker = '__NETWORK_CHECK_METRICS__'
    $curlArguments = @(
        '--silent', '--show-error', '--location', '--max-redirs', '4',
        '--connect-timeout', "$ConnectTimeoutSeconds", '--max-time', "$RequestTimeoutSeconds",
        '--write-out', "`n${marker}%{http_code}|%{remote_ip}|%{url_effective}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{ssl_verify_result}`n"
    )
    if ($Method -eq 'HEAD') { $curlArguments += '--head' }
    else { $curlArguments += @('--dump-header', '-') }
    $curlArguments += $Url

    # Native stderr is captured without invoking any shell or following page scripts.
    $savedErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawLines = @(& $curlCommand.Source @curlArguments 2>&1 | ForEach-Object { $_.ToString() })
        $curlExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedErrorPreference }
    $raw = $rawLines -join "`n"
    $metricLine = @($rawLines | Where-Object { $_.StartsWith($marker) }) | Select-Object -Last 1
    $metrics = if ($metricLine) { $metricLine.Substring($marker.Length).Split('|') } else { @('000', '', $Url, '0', '0', '0', '') }
    $statusCode = 0
    [void][int]::TryParse($metrics[0], [ref]$statusCode)
    $connectSeconds = [double]::Parse($metrics[4], [Globalization.CultureInfo]::InvariantCulture)
    $tlsSeconds = [double]::Parse($metrics[5], [Globalization.CultureInfo]::InvariantCulture)
    $category = switch ($curlExit) {
        0 { if ($statusCode -ge 400) { 'HTTP_ERROR' } else { 'HTTP_RESPONSE' } }
        6 { 'DNS_FAILURE' }
        7 { 'TCP_FAILURE' }
        35 { 'TLS_HANDSHAKE_FAILURE' }
        60 { 'TLS_CERTIFICATE_FAILURE' }
        28 {
            # Some curl builds leave timing fields at zero on failed handshakes.
            # Use explicit error evidence, otherwise preserve the uncertainty.
            if ($raw -match '(?i)(SSL|TLS) connection timeout') { 'TLS_TIMEOUT' }
            elseif ($raw -match '(?i)Failed to connect|Could not connect') { 'CONNECT_TIMEOUT' }
            elseif ($tlsSeconds -gt 0 -or (-not $Url.StartsWith('https:') -and $connectSeconds -gt 0)) { 'HTTP_TIMEOUT' }
            else { 'TIMEOUT_STAGE_UNCONFIRMED' }
        }
        default { 'CLIENT_OR_NETWORK_ERROR' }
    }
    # Keep evidence useful to diagnosis; omit Set-Cookie, form values, and body text.
    $evidence = @($rawLines | Where-Object { $_ -match '^(HTTP/\S+\s|Date:|Location:|Content-Type:|Content-Length:|curl:)' })
    $title = $null
    $scripts = @()
    $editorHints = @()
    if ($Method -eq 'GET' -and $statusCode -ge 200 -and $statusCode -lt 400) {
        $titleMatch = [regex]::Match($raw, '<title[^>]*>(.*?)</title>', 'IgnoreCase,Singleline')
        if ($titleMatch.Success) { $title = [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value.Trim()) }
        $scripts = @([regex]::Matches($raw, '<script\b[^>]*\bsrc\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase') | ForEach-Object { $_.Groups[1].Value } | Select-Object -First 20)
        $editorHints = @(@('ueditor', 'tinymce', 'ckeditor', 'kindeditor', 'wangEditor') | Where-Object { $raw.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    }
    return [pscustomobject]@{
        url = $Url; method = $Method; curlExit = $curlExit; category = $category
        httpCode = $statusCode; remoteIp = $metrics[1]; finalUrl = $metrics[2]
        dnsSeconds = $metrics[3]; connectSeconds = $metrics[4]; tlsSeconds = $metrics[5]
        tlsVerifyResult = $metrics[6]; evidence = $evidence
        publicPageTitle = $title; publicScriptSources = $scripts; editorStringHints = $editorHints
    }
}

$dnsRecords = @()
$tcpRecords = @()
foreach ($targetHost in @($targetUrls | ForEach-Object { ([uri]$_).Host } | Select-Object -Unique)) {
    $dnsRecords += Get-PublicDnsRecord $targetHost
    foreach ($targetPort in @(80, 443)) { $tcpRecords += Test-PublicTcpPort $targetHost $targetPort }
}
$requestRecords = @()
foreach ($targetUrl in $targetUrls) {
    foreach ($method in @('HEAD', 'GET')) { $requestRecords += Invoke-PublicRequest $targetUrl $method }
}
$zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$localTimestamp = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone).ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
[pscustomobject]@{
    checkedAtShanghai = $localTimestamp
    scope = 'Public URLs only; no login, cookies, POST, or site writes'
    curlPath = $curlCommand.Source
    dns = $dnsRecords; tcp = $tcpRecords; requests = $requestRecords
    interpretation = @(
        'HTTP status alone does not prove a signed-in application or editor is usable.',
        'HEAD and GET are reported separately because servers may treat HEAD differently.',
        'DNS addresses and remoteIp are observed in this environment, not proof of the origin server address.',
        'TLS verification is enabled. A value of 0 after a failed handshake is not proof that a certificate was verified.',
        'A timeout with zero timing fields does not establish its layer; the separate TCP probe may have different results.',
        'Public script names or string matches do not identify the actual signed-in editor or its HTML allowlist.'
    )
} | ConvertTo-Json -Depth 8
