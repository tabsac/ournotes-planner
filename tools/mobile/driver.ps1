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
  [int]$StepRetries = 1,    # node 步骤失败后重试次数（重试前硬刷隧道；判据不变）
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
# -Url 必须同时告诉 node 侧：`app-client.js` 是按 `WATCH_URL` 认「应用页」的（选 target 也按它的 path）。
# 只改 -Url 不改 WATCH_URL 的症状是「浏览器开了新 URL，驱动却去找旧 URL 的 target」。
$env:WATCH_URL = $Url
# 选 devtools socket 时要认的「应用页路径」：拿 -Url 的路径段（默认 /ournotes-planner/）
$UrlPath = try { ([uri]$Url).AbsolutePath } catch { '/ournotes-planner/' }
if (-not $UrlPath) { $UrlPath = '/ournotes-planner/' }
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
  # 「同意」= 首启/`pm clear` 之后的「服务协议和隐私政策」（拒绝 / 同意）——
  # 之前没列进来，`-Reopen` 之后它会一直挡在页面前面（devtools 于是不应答）。
  foreach ($label in @('我已了解', '不再提醒', '同意')) {
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

# 隧道修复 watchdog：每 3 秒确认 forward/reverse 还在**且真的能用**，缺了就补、死了就重建
function Start-TunnelWatch($port, $sock) {
  return Start-Job -ScriptBlock {
    param($AdbExe, $Ser, $Cdp, $Web, $SockName, $WatchLog)
    function Note($m) { Add-Content $WatchLog "[$(Get-Date -Format HH:mm:ss)] $m" -Encoding utf8 }
    $miss = 0
    while ($true) {
      # 云手机会周期性掉线（"device offline"），一掉线 forward 全没 —— 先确保设备在线
      $devs = (& $AdbExe devices 2>&1 | Out-String)
      $online = $devs -match ([regex]::Escape($Ser) + '\s+device')
      if (-not $online) {
        Note "device offline -> reconnect"
        & $AdbExe connect $Ser 2>&1 | Out-Null
        Start-Sleep -Seconds 2
      }
      $fwd = (& $AdbExe -s $Ser forward --list 2>&1 | Out-String)
      # 核对的是「tcp:<port> -> **我们这个 socket**」整条映射，不是「端口出现过」：
      # 主机端口被别的程序占着时，adb 的 forward 根本建不上，而光看端口是看不出来的
      # （见 driver.ps1 里 Ensure-Forward 的注释）。
      $want = [regex]::Escape("tcp:$Cdp") + '\s+localabstract:' + [regex]::Escape($SockName)
      $mapped = $fwd -match $want

      # ⚠️ 「列里有」≠「能用」。云手机掉线时 adb 会把**本地监听留着**、绑在已经死掉的
      #    transport 上：`forward --list` 照样列出这条映射，而连接进来只会 socket hang up。
      #    这时反复「缺了再加」是**无效的**（加的是同一条，adb 幂等忽略）——
      #    2026-10-05 那一轮就是这么卡死的：watchdog 每 3 秒补一次，CDP 十五分钟没应答。
      #    所以这里要**探**一下：探不通且设备在线，就硬重建（只动 forward，
      #    **绝不 remove-all reverse** —— 页面可能正通过它下载几十 MB）。
      $probe = ''
      if ($mapped) { $probe = (& curl.exe -s --max-time 4 "http://127.0.0.1:$Cdp/json" 2>$null | Out-String) }
      $cdpAlive = ($probe -match 'webSocketDebuggerUrl') -and ($probe -notmatch 'Adobe UXP')
      if ($cdpAlive) { $miss = 0 } else {
        $miss++
        if (-not $mapped) {
          # ⚠️ 这里**绝不能**先 forward --remove-all：那会把**正在用的连接**一起掐断
          #    （CDP 的 WebSocket 就挂在上面，症状是 "cdp connected" 之后每条命令都超时）。
          #    直接补一条即可；已存在时 adb 只会报一句无害的错。
          $add = (& $AdbExe -s $Ser forward "tcp:$Cdp" "localabstract:$SockName" 2>&1 | Out-String).Trim()
          Note "re-forward tcp:$Cdp -> $SockName | list=[$($fwd.Trim())] add=[$add]"
        } elseif ($online -and $miss -ge 20) {
          & $AdbExe -s $Ser forward --remove-all 2>&1 | Out-Null
          $add = (& $AdbExe -s $Ser forward "tcp:$Cdp" "localabstract:$SockName" 2>&1 | Out-String).Trim()
          Note "CDP 连续 $miss 次探不通（映射在但已死）-> 硬重建 forward | add=[$add]"
          $miss = 0
        }
      }
      $rev = (& $AdbExe -s $Ser reverse --list 2>&1 | Out-String)
      if ($rev -notmatch "tcp:$Web\b") {
        & $AdbExe -s $Ser reverse "tcp:$Web" "tcp:$Web" 2>&1 | Out-Null
        Note "re-reverse tcp:$Web"
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
    # `Adobe UXP` = 那个端点是假货（After Effects 占着这个主机端口，见 Ensure-Forward 的注释）。
    # 它同样回 webSocketDebuggerUrl，所以光看这一个字段会把**别的程序**当成手机。
    if (($body -match 'webSocketDebuggerUrl') -and ($body -notmatch 'Adobe UXP')) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

# 主机上这一端口是不是**别的程序**在听。
# ⚠️ 为什么必须查：2026-10-05 卡了整整一轮的假象就出在这里 ——
#    Adobe After Effects 的 UXP 调试端口**默认就是 9222**（`/json/version` 自称 `{"Browser":"Adobe UXP"}`）。
#    9222 被它占着时，`adb forward tcp:9222 …` 只回一句
#    `cannot bind listener: … 10048` 就结束了，脚本原来**照样**打印「forward tcp:9222 -> sock」；
#    接着 Wait-Cdp 去 curl 9222，After Effects 的 devtools 也回 `webSocketDebuggerUrl`、也列一个
#    `type=page` 的 target —— 于是脚本大喊 CDP READY，node 却连到 After Effects 上，
#    症状是「target 的 url 是空的」「Cannot find default execution context」。
#    换句话说：那几轮查的「手机没导航」「模态框挡着」全是**查错了机器**。
#    必须在 `forward --remove-all` **之后**调用，否则 adb 自己的监听会被误判成占用。
function Test-HostPortBusy($port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Dispose() }
}

# 建 CDP forward，并**用 forward --list 核对真的建上了**；端口被占就往后换。
# 返回真正生效的端口（建不上返回 0）。光看 adb 那行输出不算数 —— 就是这个「没核对」害的。
function Ensure-Forward($startPort, $sock, $maxTries = 12) {
  for ($p = $startPort; $p -lt $startPort + $maxTries; $p++) {
    if (Test-HostPortBusy $p) { Say "  主机 127.0.0.1:$p 已被别的程序占用，换端口"; continue }
    A @('forward', "tcp:$p", "localabstract:$sock") | ForEach-Object { if ("$_".Trim()) { Say "  forward: $_" } }
    $list = (A @('forward', '--list')) -join "`n"
    if ($list -match ("tcp:$p\s+localabstract:" + [regex]::Escape($sock))) {
      if ($p -ne $startPort) { Say "  ⚠️ 原定端口 $startPort 用不了，CDP 改用 tcp:$p" }
      return $p
    }
    Say "  端口 $p 没建上（forward --list 里没有 tcp:$p -> $sock），换下一个"
  }
  return 0
}

# 在设备上找出**真正装着应用页**的那个 devtools socket。
#
# 为什么不能像以前那样「grep webview_devtools_remote_ 取第一个」：
#   * 真机上同时开着别的 WebView —— 实测用户手机上就有一个「NapCat 监控」页面，
#     还有夸克自己首页的 WebView；谁先出现谁就被选中，于是驱动连到一个**跟应用无关的页面**上
#     （症状：target 的 url 是空串/别人的地址、document 里没有应用的元素，看起来像应用坏了）。
#   * 不同实现的 socket 名也不一样：云手机的 X 浏览器是 `webview_devtools_remote_<pid>`，
#     真机夸克是 `huawei_webview_devtools_remote_<pid>`；本机自带的华为浏览器（ArkWeb）干脆不开。
# 所以：按 `*devtools_remote_<pid>` 收全集，再**用 /json 里有没有应用页**来定谁是谁。
function Find-AppDevtools($startPort, $appPath, $rounds = 12, $gapSec = 4) {
  $firstAny = $null
  foreach ($round in 1..$rounds) {
    $list = ((A @('shell', "cat /proc/net/unix | grep -o -E '[A-Za-z_]*devtools_remote_[0-9]+' | sort -u")) -join ' ').Trim()
    $socks = @([regex]::Matches($list, '[A-Za-z_]*devtools_remote_[0-9]+') | ForEach-Object { $_.Value } | Select-Object -Unique)
    foreach ($cand in $socks) {
      $p = Ensure-Forward $startPort $cand
      if (-not $p) { continue }
      Start-Sleep -Milliseconds 600
      $body = (& curl.exe -s --max-time 6 "http://127.0.0.1:$p/json" 2>$null | Out-String)
      if (($body -match [regex]::Escape($appPath)) -and ($body -notmatch 'Adobe UXP')) {
        Say "  选中 socket $cand（tcp:$p 的 /json 里有应用页 $appPath）"
        return @{Sock = $cand; Port = $p}
      }
      if (-not $firstAny -and ($body -match '"type"\s*:\s*"page"')) {
        $firstAny = $cand
        Say "  候选 socket $cand（tcp:$p）里还没有应用页，先记着"
      }
      # 认错了就把这条映射撤掉，别把端口占着（只撤自己这一条，不动别人的）
      A @('forward', '--remove', "tcp:$p") | Out-Null
      Start-Sleep -Milliseconds 200
    }
    if (-not $socks.Count) { Say "  第 $round 轮：设备上还没有任何 devtools socket" }
    Start-Sleep -Seconds $gapSec
  }
  if ($firstAny) {
    $p = Ensure-Forward $startPort $firstAny
    if ($p) { Say "  ⚠️ 一直没看到应用页，退回第一个有 page 的 socket $firstAny（tcp:$p）"; return @{Sock = $firstAny; Port = $p} }
  }
  return $null
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
      if ($code -match '200') {
        Say "  phone -> host server: HTTP 200"
      } elseif ($code -match 'not found|inaccessible|No such file') {
        # ⚠️ 不是所有手机都有 curl（实测 HarmonyOS 的 HBN-AL80 就没有，只有 toybox）。
        #    这条自检只是「reverse 隧道 + server.py 都活着」的旁证，拿不到就别拿它当失败 ——
        #    应用到底能不能 boot 出来，才是真正准的判据（watch.js 会说话）。
        Say "  手机上没有 curl（$code），跳过这条自检"
      } else {
        Say "  FATAL: server.py 没起？（手机侧取数返回：$code）"; exit 3
      }

      A @('shell', "am start -a android.intent.action.VIEW -d '$Url' -n $BrowserAct") | ForEach-Object { Say "  $_" }
      Start-Sleep -Seconds 8
      Dismiss-BrowserDialog | Out-Null
      Start-Sleep -Seconds 4

      $sock = ''
      A @('forward', '--remove-all') | Out-Null
      $found = Find-AppDevtools $port $UrlPath
      if (-not $found) { Say "  没找到装着应用页的 devtools socket（应用页没打开？）"; continue }
      $sock = $found.Sock
      $port = $found.Port
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
        if ($body -match 'Adobe UXP') {
          Say "  FATAL: 主机 tcp:$port 上是 Adobe UXP（After Effects），不是手机 —— 端口被抢了"
          break
        }
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
        if ($body -notmatch '/ournotes-planner/') {
          Say "  ⚠️ /json 里还没有应用页 target（可能还没导航完）；watch.js 会自己 Page.navigate"
        }
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

    # `adb <参数...>`：在**本进程**里敲一次 adb。
    # 为什么要有这一步：隧道（forward/reverse）由本进程持有，别的 shell 里敲 adb 会换掉 daemon、
    # 把隧道一起弄没（见文件开头）；而有些取证只能从设备侧做，例如「导出到底有没有真落盘」：
    #   'adb shell ls -l /sdcard/Download'
    if ($parts[0] -eq 'adb') {
      Say "=== adb $($rest -join ' ') ==="
      A $rest | ForEach-Object { Say "  $_" }
      continue
    }

    # `tap <文本>`：在**当前屏幕**上按文本找节点并点它的中心（用 uiautomator 的 bounds，不猜坐标）。
    # 用途：点掉只有原生层才有的东西 —— 最典型的是 X 浏览器的「文件下载」确认框（按钮「确定」）：
    #   'tap 确定'
    # 找不到该文本就**不点**（只记一行日志），绝不猜坐标。
    if ($parts[0] -eq 'tap') {
      $label = ($rest -join ' ')
      Say "=== tap '$label' ==="
      $tmp = Join-Path $OutDir '_ui_tap.xml'
      A @('shell', 'rm -f /sdcard/_dsh_ui.xml') | Out-Null
      A @('shell', 'uiautomator dump /sdcard/_dsh_ui.xml') | Out-Null
      Run $Adb @('-s', $Serial, 'pull', '/sdcard/_dsh_ui.xml', $tmp) | Out-Null
      if (-not (Test-Path $tmp)) { Say "  (uiautomator dump 没拿到，跳过)"; continue }
      $xml = Get-Content -Raw -Encoding UTF8 $tmp
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      $node = [regex]::Match($xml, '<node[^>]*text="' + [regex]::Escape($label) + '"[^>]*>')
      if (-not $node.Success) { Say "  没找到文本为 '$label' 的节点，不点"; continue }
      $b = [regex]::Match($node.Value, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
      if (-not $b.Success) { Say "  节点没有 bounds，不点"; continue }
      $x = [int](([int]$b.Groups[1].Value + [int]$b.Groups[3].Value) / 2)
      $y = [int](([int]$b.Groups[2].Value + [int]$b.Groups[4].Value) / 2)
      Say "  tap at ($x,$y)"
      A @('shell', "input tap $x $y") | Out-Null
      Start-Sleep -Seconds 3
      continue
    }

    # node 步骤：跑之前先等 CDP 通；**失败了硬刷一次隧道再重试一遍**。
    # 为什么值得重试：云手机掉线会把 CDP 的 forward 弄死，`watch.js` 在一次掉线里
    # 等不到 /json 就整轮退出（它自己的重试窗口只有 150 秒）。一次掉线毁掉一整轮太亏。
    # ⚠️ 重试**不放松任何判据**：比对还是 compare.js 对原生 oracle 逐条比，
    #    重跑只是把「同一件事」再做一遍；watch.js 开跑先删旧结果文件，所以不会拿旧结果充数。
    $attempts = $StepRetries + 1
    for ($try = 1; $try -le $attempts; $try++) {
      if ($try -gt 1) {
        if ($Offline) {
          Say "  ---- 第 $try 次尝试（-Offline：隧道不归本进程管，直接重跑）----"
        } else {
          Say "  ---- 第 $try 次尝试前：硬刷隧道（forward remove-all + 重建；reverse 只补不删）----"
          A @('forward', '--remove-all') | Out-Null
          $np = Ensure-Forward ([int]$env:CDP_PORT) $sock
          A @('reverse', "tcp:$WebPort", "tcp:$WebPort") | Out-Null
          if (-not $np) { Say "  FATAL: 刷不出可用端口"; $failed++; break }
          if ("$np" -ne "$env:CDP_PORT") {
            $env:CDP_PORT = "$np"
            if ($tunnel) { Stop-Job $tunnel -ErrorAction SilentlyContinue; Remove-Job $tunnel -Force -ErrorAction SilentlyContinue }
            $tunnel = Start-TunnelWatch $np $sock
            Say "  CDP 端口改为 tcp:$np，watchdog 已跟着换"
          }
        }
      }
      if (-not (Wait-Cdp $env:CDP_PORT 120)) { Say "FATAL: 跑 $step 之前 CDP 就不通"; continue }
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
      Say "  gate: cdp=$cdpOk (尝试 $try/$attempts)"
      Dismiss-BrowserDialog | Out-Null
      Say "=== node $step (CDP_PORT=$env:CDP_PORT) ==="
      # 逐行转发（不要先收进变量再打）：watch.js 要跑好几分钟，看不到实时进度就没法判断卡在哪
      & node @(@($parts[0]) + $rest) 2>&1 | ForEach-Object { Say "  $_" }
      if ($LASTEXITCODE -eq 0) { break }
      Say "  ^^^ exit=$LASTEXITCODE"
      if ($try -eq $attempts) { $failed++ }
    }
  }
  Say "DONE failed=$failed"
  exit $failed
} finally {
  foreach ($j in @($ping, $tunnel)) {
    if ($j) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue }
  }
}
