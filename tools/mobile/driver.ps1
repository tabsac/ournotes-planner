# 真机验证的一体化驱动：**在一次进程生命周期里**做完
#   连接设备 → 建 reverse/forward → 确保浏览器打开应用页 → 依次跑 node 测试脚本
#
# 为什么非要「一次做完」：跑它的环境里，命令一结束就可能把进程树（连带 adb daemon）收掉，
# 而 reverse/forward 只存在 daemon 的内存里 —— 别的命令一碰 adb，隧道就可能被换掉。
# 所以隧道由**本进程**持有，另外挂 watchdog 每 3 秒确认一次、缺了就补。
#
# ⚠️ 测试期间**不要**再从别的 shell 敲 adb（会换掉 daemon、打断隧道）；
#    手机上的 UI 操作也都在本脚本里做。
#
#   & tools/mobile/driver.ps1 -Steps 'watch.js solver-ap','compare.js solver-ap'
#
#   -Serial  手机/云手机的 adb 串号（默认取 $env:MOBILE_SERIAL）
#   -Adb     adb.exe 路径（默认取 $env:ANDROID_ADB / $env:ANDROID_HOME / $env:ANDROID_SDK_ROOT）
#   -Reopen  先强杀浏览器再起来（会重新弹一次反诈弹窗，脚本会自动点掉）
param(
  [string]$Serial   = $(if ($env:MOBILE_SERIAL) { $env:MOBILE_SERIAL } else { '' }),
  [string]$Adb      = $(if ($env:ANDROID_ADB) { $env:ANDROID_ADB }
                        elseif ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
                        elseif ($env:ANDROID_SDK_ROOT) { Join-Path $env:ANDROID_SDK_ROOT 'platform-tools\adb.exe' }
                        else { 'adb' }),
  [int]$WebPort     = 8899,
  [int]$CdpPort     = 9222,
  [string]$Url      = 'http://localhost:8899/ournotes-planner/',
  [string]$BrowserPkg = 'com.mmbox.xbrowser',
  [string]$BrowserAct = 'com.mmbox.xbrowser/.BrowserActivity',
  [string[]]$Steps  = @(),
  [string]$Log      = '',
  [switch]$Reopen,          # 先强杀浏览器再起来（会重新弹一次反诈弹窗，脚本会自动点掉）
  [switch]$Offline          # 不重建隧道，直接用已有的 forward（调试用）
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

if (-not $Serial) {
  Write-Host '必须指定手机：-Serial <adb 串号>，或先设 $env:MOBILE_SERIAL（例如 103.36.194.17:495 或 emulator-5554）'
  exit 2
}

# 产出（日志、结果、进度轨迹）统一放 work/mobile/，与 node 脚本的 MOBILE_OUT_DIR 保持一致
$OutDir = if ($env:MOBILE_OUT_DIR) { $env:MOBILE_OUT_DIR } else { Join-Path (Resolve-Path "$PSScriptRoot\..\..").Path 'work\mobile' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$env:MOBILE_OUT_DIR = $OutDir
if (-not $Log) { $Log = Join-Path $OutDir 'driver.log' }
$WatchLogPath = Join-Path $OutDir 'tunnel_watch.log'

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}
function Run($exe, $argv) { & $exe @argv 2>&1 | ForEach-Object { "$_" } }
function A($argv) { Run $Adb (@('-s', $Serial) + $argv) }

Set-Content -Path $Log -Value "=== phone_run $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') serial=$Serial adb=$Adb steps=$($Steps -join ' | ')" -Encoding utf8

# X 浏览器第一次打开会弹「防止诈骗提醒」模态框，**会挡住页面、也让 CDP 不应答**
# （实测：页面被挡时 /json 请求超时 curl exit 28，一直等不到 webSocketDebuggerUrl）。
# 这里用 uiautomator 读它的真实 bounds 再点，别拿截图估坐标。
function Dismiss-BrowserDialog {
  $tmp = Join-Path $OutDir '_ui_tmp.xml'
  A @('shell', 'rm -f /sdcard/_dsh_ui.xml') | Out-Null
  A @('shell', 'uiautomator dump /sdcard/_dsh_ui.xml') | Out-Null
  Run $Adb @('-s', $Serial, 'pull', '/sdcard/_dsh_ui.xml', $tmp) | Out-Null
  A @('shell', 'rm -f /sdcard/_dsh_ui.xml') | Out-Null
  if (-not (Test-Path $tmp)) { return $false }
  $xml = Get-Content -Raw -Encoding UTF8 $tmp
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  $hit = $false
  foreach ($label in @('我已了解', '不再提醒')) {
    $node = [regex]::Match($xml, '<node[^>]*text="' + [regex]::Escape($label) + '"[^>]*>')
    if (-not $node.Success) { continue }
    $b = [regex]::Match($node.Value, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if (-not $b.Success) { continue }
    $x = [int](([int]$b.Groups[1].Value + [int]$b.Groups[3].Value) / 2)
    $y = [int](([int]$b.Groups[2].Value + [int]$b.Groups[4].Value) / 2)
    Say "  dismiss browser dialog: tap '$label' at ($x,$y)"
    A @('shell', "input tap $x $y") | Out-Null
    Start-Sleep -Seconds 2
    $hit = $true
  }
  # X 浏览器还会弹「一个5星好评…」的评价条，压在页面底部、会挡住应用自己的按钮。
  # ⚠️ **不要用 keyevent BACK 关它**：实测 BACK 会让 WebView 的 page target 换掉，
  #    紧接着 watch.js 拿着刚列出的旧 target 去连，直接 ws error（TypeError）挂掉。
  #    这里改成找它的关闭节点来点；找不到就只把节点清单记进日志，不做危险动作。
  if ($xml -match '给5星|好评给|rate') {
    $nodes = [regex]::Matches($xml, '<node[^>]*>') | ForEach-Object {
      $n = $_.Value
      $text = [regex]::Match($n, 'text="([^"]*)"').Groups[1].Value
      $desc = [regex]::Match($n, 'content-desc="([^"]*)"').Groups[1].Value
      $rid = [regex]::Match($n, 'resource-id="([^"]*)"').Groups[1].Value
      $cls = [regex]::Match($n, 'class="([^"]*)"').Groups[1].Value
      $b = [regex]::Match($n, 'bounds="([^"]*)"').Groups[1].Value
      if ($text -or $desc) { "text='$text' desc='$desc' id='$rid' cls='$cls' $b" }
    }
    Say "  rating popup present; nodes:"
    $nodes | Select-Object -First 25 | ForEach-Object { Say "    $_" }
    $close = [regex]::Match($xml, '<node[^>]*(content-desc="[^"]*(关闭|close|Close)[^"]*"|resource-id="[^"]*(close|dismiss)[^"]*")[^>]*>')
    if ($close.Success) {
      $b = [regex]::Match($close.Value, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
      if ($b.Success) {
        $x = [int](([int]$b.Groups[1].Value + [int]$b.Groups[3].Value) / 2)
        $y = [int](([int]$b.Groups[2].Value + [int]$b.Groups[4].Value) / 2)
        Say "  tap rating-popup close at ($x,$y)"
        A @('shell', "input tap $x $y") | Out-Null
        Start-Sleep -Seconds 2
        $hit = $true
      }
    } else {
      Say "  (没找到关闭节点，先不动它；真挡住页面会体现在结果里)"
    }
  }
  return $hit
}

# 隧道修复 watchdog：每 5 秒确认 forward/reverse 还在，缺了就补
function Start-TunnelWatch($port, $sock) {
  return Start-Job -ScriptBlock {
    param($AdbExe, $Ser, $Cdp, $Web, $SockName, $WatchLog)
    while ($true) {
      # 云手机会周期性掉线（"device offline"），一掉线 forward 全没 —— 先确保设备在线
      $devs = (& $AdbExe devices 2>&1 | Out-String)
      if ($devs -notmatch [regex]::Escape($Ser) + '\s+device') {
        Add-Content $WatchLog "[$(Get-Date -Format HH:mm:ss)] device offline -> reconnect" -Encoding utf8
        & $AdbExe connect $Ser 2>&1 | Out-Null
        Start-Sleep -Seconds 2
      }
      $fwd = (& $AdbExe -s $Ser forward --list 2>&1 | Out-String)
      if ($fwd -notmatch "tcp:$Cdp\b") {
        # ⚠️ 这里**绝不能**先 forward --remove-all：那会把**正在用的连接**一起掐断
        #    （CDP 的 WebSocket 就挂在上面，症状是 "cdp connected" 之后每条命令都超时）。
        #    直接补一条即可；已存在时 adb 只会报一句无害的错。
        $add = (& $AdbExe -s $Ser forward "tcp:$Cdp" "localabstract:$SockName" 2>&1 | Out-String).Trim()
        Add-Content $WatchLog "[$(Get-Date -Format HH:mm:ss)] re-forward tcp:$Cdp -> $SockName | list=[$($fwd.Trim())] add=[$add]" -Encoding utf8
      }
      $rev = (& $AdbExe -s $Ser reverse --list 2>&1 | Out-String)
      if ($rev -notmatch "tcp:$Web\b") {
        & $AdbExe -s $Ser reverse "tcp:$Web" "tcp:$Web" 2>&1 | Out-Null
        Add-Content $WatchLog "[$(Get-Date -Format HH:mm:ss)] re-reverse tcp:$Web" -Encoding utf8
      }
      Start-Sleep -Seconds 3
    }
  } -ArgumentList $Adb, $Serial, $port, $WebPort, $sock, $WatchLogPath
}

# 每个 node 步骤之前都等 CDP 真的能应答 —— 云手机刚掉线过的话，这里会等到 watchdog 把隧道补回来
function Wait-Cdp($port, $timeoutSec = 300) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $body = (& curl.exe -s --max-time 6 "http://127.0.0.1:$port/json" 2>$null | Out-String)
    if ($body -match 'webSocketDebuggerUrl') { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

$ping = Start-Job -ScriptBlock {
  param($A, $S) while ($true) { & $A -s $S shell "echo ping" 2>&1 | Out-Null; Start-Sleep -Seconds 4 }
} -ArgumentList $Adb, $Serial
Say "ping watchdog started"

$tunnel = $null
try {
  # ---- 1. 设备 ----
  $ok = $false
  foreach ($try in 1..6) {
    Run $Adb @('connect', $Serial) | ForEach-Object { Say "  connect: $_" }
    $d = (Run $Adb @('devices')) -join "`n"
    if ($d -match [regex]::Escape($Serial) + '\s+device') { $ok = $true; break }
    Start-Sleep -Seconds 3
  }
  if (-not $ok) { Say "FATAL: device unreachable $Serial"; exit 2 }
  Say ("device online, sdk=" + ((A @('shell', 'getprop ro.build.version.sdk')) -join '').Trim())

  if (-not $Offline) {
    $ready = $false
    foreach ($attempt in 1..3) {
      Say "--- bring-up attempt $attempt ---"
      $port = $CdpPort + ($attempt - 1)

      if ($Reopen -or $attempt -gt 1) {
        Say "  restarting browser"
        A @('shell', "am force-stop $BrowserPkg") | Out-Null
        Start-Sleep -Seconds 3
      }

      A @('reverse', '--remove-all') | Out-Null
      A @('reverse', "tcp:$WebPort", "tcp:$WebPort") | ForEach-Object { Say "  reverse: $_" }
      $code = ((A @('shell', "curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:$WebPort/ournotes-planner/index.html")) -join '').Trim()
      Say "  phone -> host server: HTTP $code"
      if ($code -notmatch '200') { Say "  FATAL: server.py 没起？"; exit 3 }

      A @('shell', "am start -a android.intent.action.VIEW -d '$Url' -n $BrowserAct") | ForEach-Object { Say "  $_" }
      Start-Sleep -Seconds 8
      Dismiss-BrowserDialog | Out-Null
      Start-Sleep -Seconds 4

      $sock = ''
      foreach ($t in 1..10) {
        $sock = ((A @('shell', "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | sort -u")) -join ' ').Trim()
        if ($sock -match 'webview_devtools_remote_\d+') { break }
        Start-Sleep -Seconds 2
      }
      if ($sock -notmatch 'webview_devtools_remote_\d+') { Say "  no devtools socket"; continue }
      $sock = [regex]::Match($sock, 'webview_devtools_remote_\d+').Value

      A @('forward', '--remove-all') | Out-Null
      A @('forward', "tcp:$port", "localabstract:$sock") | ForEach-Object { Say "  forward: $_" }
      A @('reverse', "tcp:$WebPort", "tcp:$WebPort") | Out-Null
      Say "  forward tcp:$port -> $sock"
      # watchdog 必须**现在就起**：云手机掉线会把 forward 抹掉，
      # 若等到 CDP READY 才起，一次掉线就能让这段等待永远等不到。
      if ($tunnel) { Stop-Job $tunnel -ErrorAction SilentlyContinue; Remove-Job $tunnel -Force -ErrorAction SilentlyContinue }
      $tunnel = Start-TunnelWatch $port $sock
      Say "  tunnel-repair watchdog started"

      # devtools 被模态框挡着时**完全不应答**；应用还在 boot（12 MB wasm + Python）
      # 时也可能长时间不应答 —— 实测要等 1~2 分钟。所以耐心轮询，
      # **不要**中途强杀浏览器（那会把 boot 又打回原点）。
      $alive = $false
      foreach ($t in 1..90) {
        Start-Sleep -Seconds 5
        $body = (& curl.exe -s --max-time 8 "http://127.0.0.1:$port/json" 2>$null | Out-String)
        if ($body -match 'webSocketDebuggerUrl') { $alive = $true; break }
        if ($t -eq 4) { Dismiss-BrowserDialog | Out-Null }
        if ($t % 12 -eq 0) {
          $wlog = (Get-Content $WatchLogPath -Tail 3 -ErrorAction SilentlyContinue) -join ' ; '
          Say "  cdp still silent ($([int]($t*5))s) tunnel: $wlog"
        }
      }
      if ($alive) {
        $env:CDP_PORT = "$port"
        Say "CDP READY on tcp:$port"
        ($body | ConvertFrom-Json) | ForEach-Object { Say ("  target: {0}  {1}" -f $_.type, $_.url) }
        $ready = $true
        break
      }
      Say "  CDP gave no usable response"
    }
    if (-not $ready) { Say "FATAL: CDP 起不来"; exit 5 }
  }

  # ---- 2. 依次跑 node 步骤 ----
  $failed = 0
  foreach ($step in $Steps) {
    $parts = $step -split '\s+'
    $rest = @()
    if ($parts.Length -gt 1) { $rest = $parts[1..($parts.Length - 1)] }
    if (-not (Wait-Cdp $env:CDP_PORT 120)) { Say "FATAL: 跑 $step 之前 CDP 就不通"; $failed++; continue }
    # 只等 CDP 通就开跑。
    # ⚠️ 别再拿「手机侧 curl 取 index.html」当 reverse 隧道的健康探针：
    #    reverse 和 forward 走的是同一条 adb 连接，应用启动时正在下载 12 MB wasm，
    #    探针要么排在后面超时（实测卡 5 分钟），要么被饿死返回 000 —— 全是误报。
    #    reverse 到底通不通，看应用自己能不能 boot 出来最准；watch.js 会因此整页重来。
    $cdpOk = $false
    for ($i = 1; $i -le 3 -and -not $cdpOk; $i++) {
      $cdpOk = Wait-Cdp $env:CDP_PORT 30
      if (-not $cdpOk) { Say "  gate ${i}: cdp 不通，等隧道补回来 …" }
    }
    Say "  gate: cdp=$cdpOk"
    Say "  隧道稳定性 $stable/2"
    Dismiss-BrowserDialog | Out-Null
    Say "=== node $step (CDP_PORT=$env:CDP_PORT) ==="
    # 逐行转发（不要先收进变量再打）：watch.js 要跑好几分钟，看不到实时进度就没法判断卡在哪
    & node @(@($parts[0]) + $rest) 2>&1 | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { Say "  ^^^ exit=$LASTEXITCODE"; $failed++ }
  }
  Say "DONE failed=$failed"
  exit $failed
} finally {
  foreach ($j in @($ping, $tunnel)) {
    if ($j) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue }
  }
}
