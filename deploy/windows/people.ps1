<#
.SYNOPSIS
  Several people on one Windows hub PC, each with a hub of their own (docs/multi-person.md): the Windows twin of
  deploy/people.sh. Run it in an elevated PowerShell ("Run as administrator"); the app shows the one line to paste.

    people.ps1 setup [-Owner <account>] -Name <your name> [-Color '#rrggbb']
         once: the model gate, the list of people, and the small SYSTEM task that lets your hub add people from the
         app (Settings, People on this machine)
    people.ps1 add <name> [-Color '#rrggbb']
         the same as Add a person in the app: a Windows account for that person (no password anyone knows, no sign-in)
         running their own hub on its own port, reachable with a QR code from anywhere, and an invitation for their
         first device (works once, for 3 days)
    people.ps1 list
    people.ps1 pair <name>
         a new invitation for that person's device
    people.ps1 ward <name> -Helper <your name> -Hash <sha256>
         offer to help that person with their devices (your hub does this from the app; they say yes in theirs)
    people.ps1 update
         every other person's hub to your current code, and the gate restarted (after updating your own hub)
    people.ps1 stop <name>
         stops their hub; their data and account stay (the account disabled)
    people.ps1 remove <name> [-Erase <name again>]
         stops their hub; with -Erase also deletes their account and data for good
    people.ps1 remove-account <account> -Erase <account>
    people.ps1 unsetup
         the gate and the SYSTEM task removed (remove the others first)
.DESCRIPTION
  Linux's people.sh rests on four things, and this script makes the Windows version of each:
  - One account per person, so one hub cannot read another's files: a local account aeneas-<name> with a long random
    password that is never stored or shown, hidden from the sign-in screen, refused sign-in at the screen, over Remote
    Desktop and from the network, and allowed only to run as a batch job. Its hub lives in
    %ProgramData%\Aeneas\people\<account>, open to that account, SYSTEM and Administrators only.
  - Each person's hub starts at boot with nobody signed in: a scheduled task per person, run as that account without a
    stored password (S4U), like the owner's own "\Aeneas\Aeneas hub". deploy\windows\hub-service.ps1 keeps it running.
  - The owner's hub never runs anything as an administrator: it drops a request (a person's name, nothing else) into
    %ProgramData%\Aeneas\requests, which only the owner's account and SYSTEM can write to, and the SYSTEM task
    "\Aeneas\Aeneas people" runs the copy of this script in %ProgramFiles%\Aeneas for it. That copy changes only when
    the owner runs setup or update elevated, so code the owner's account can change never runs as SYSTEM until then.
    Progress and the result go to %ProgramData%\Aeneas\results, readable by the owner's account and SYSTEM only.
  - An address for each hub: Direct link for everyone (the invitation's QR code carries the hub's key; no Tailscale on
    their phone), plus Tailscale Serve on its own port when Tailscale runs on this PC.
  The model is shared through the model gate (hub/src/gate.ts), run as the owner by the task "\Aeneas\Aeneas gate".
  On Windows the gate cannot tell the hubs apart (Linux reads that from the operating system), so people's hubs take
  turns in the order they ask, and the owner's own hub keeps talking to the model server directly, which also keeps
  adding and removing models with the owner.

  Anyone with administrator rights on this PC, the owner included, can still open every account's files. The app says
  so before and after someone is added.

  Windows PowerShell 5.1 traps this script avoids: a native program's error output stops a script (natives run through
  X), quotes inside arguments given to a native program are dropped (none are passed; data goes in files and the
  environment), a JSON list read back is one object until it is assigned and iterated, a process's exit code is lost
  unless its handle is held, and variable names do not tell case apart ($Name is $name).
#>
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1)][string]$Who = '',
  [string]$Name = '',
  [string]$Owner = '',
  [string]$OwnerRoot = '',
  [string]$Color = '',
  [string]$Helper = '',
  [string]$Hash = '',
  [string]$Erase = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Utf8 = New-Object Text.UTF8Encoding $false
$Base = Join-Path $env:ProgramData 'Aeneas'
$RegistryFile = Join-Path $Base 'people.json'
$OwnerFile = Join-Path $Base 'owner'
$OwnerInfoFile = Join-Path $Base 'owner.json'
$RequestDir = Join-Path $Base 'requests'
$ResultDir = Join-Path $Base 'results'
$PeopleRoot = Join-Path $Base 'people'
$RootCopyDir = Join-Path $env:ProgramFiles 'Aeneas'
$RootCopy = Join-Path $RootCopyDir 'people.ps1'
$GatePort = if ($env:EA_GATE_PORT -match '^\d+$') { [int]$env:EA_GATE_PORT } else { 11435 }
$GateUrl = "http://127.0.0.1:$GatePort"
$FirstPort = 8788
# Colors people pick their hub out by, in the order they are given out (the same as people.sh).
$Palette = @('#2f8f83', '#c27c2c', '#7a5cc7', '#c4506a', '#3a7bc8', '#6b9a3a', '#b8860b', '#8a6d5a')
$TaskFolder = '\Aeneas\'
$PeopleTask = 'Aeneas people'
$GateTask = 'Aeneas gate'
$SidSystem = 'S-1-5-18'; $SidAdmins = 'S-1-5-32-544'; $SidUsers = 'S-1-5-32-545'
$UserList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
# Settings every hub on the PC shares with the owner's: the model and how it is run, web search, the day's clock.
$SharedKeys = @('EA_OLLAMA_MODEL', 'EA_OLLAMA_NUM_CTX', 'EA_OLLAMA_KEEP_ALIVE', 'EA_OLLAMA_THINK', 'EA_BACKGROUND_AI', 'EA_SEARXNG_URL', 'EA_TOR_SOCKS', 'EA_TZ')
$AdminNote = "Their data is kept apart from yours and from everyone else's, but anyone with administrator rights on this PC, you included, can still open it. Tell them before they start."

# ---------- results for the app, and messages ----------

# A request from the app (serve-requests) reports progress and its result in this file; empty from a terminal.
$ResultFile = ''
if ($env:EA_PEOPLE_RESULT) {
  try {
    $full = [IO.Path]::GetFullPath($env:EA_PEOPLE_RESULT)
    if ($full.StartsWith($ResultDir + '\', [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($full) -cmatch '^[a-z0-9-]{8,40}\.json$')) { $ResultFile = $full }
  } catch { }
}

function Write-Text([string]$file, [string]$text) {
  $tmp = "$file.tmp"
  [IO.File]::WriteAllText($tmp, $text, $Utf8)
  Move-Item -Force -LiteralPath $tmp -Destination $file
}

function Set-Result([string]$state, [hashtable]$fields = @{}) {
  if (-not $ResultFile) { return }
  $r = [ordered]@{}
  if (Test-Path -LiteralPath $ResultFile) {
    try { $old = [IO.File]::ReadAllText($ResultFile) | ConvertFrom-Json; foreach ($prop in $old.PSObject.Properties) { $r[$prop.Name] = $prop.Value } } catch { }
  }
  $r['state'] = $state
  foreach ($k in $fields.Keys) { $r[$k] = $fields[$k] }
  Write-Text $ResultFile (ConvertTo-Json -InputObject $r -Depth 8 -Compress)
}

function Die([string]$t) { Set-Result 'failed' @{ error = $t }; throw "error: $t" }
function Say([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan; Set-Result 'working' @{ step = $t } }
function Note([string]$t) { Write-Host "    $t" }

# A program outside PowerShell (icacls, robocopy, tailscale). Windows PowerShell 5.1 turns what such a program writes
# on its error output into errors, which would stop this script; whether it worked is $LASTEXITCODE, checked after.
function X {
  $ErrorActionPreference = 'Continue'
  $exe, $rest = $args
  & $exe @rest
}

function Assert-Admin {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal $me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die 'run this in a PowerShell window opened with "Run as administrator"'
  }
}

function New-Secret([int]$n) {
  $chars = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  $bytes = New-Object byte[] $n
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Valid-Name([string]$s) { return $s -cmatch '^[A-Za-z][A-Za-z ''.-]{0,29}$' }
function Valid-Color([string]$s) { return $s -cmatch '^#[0-9a-fA-F]{6}$' }
# Windows keeps local account names to 20 characters: aeneas- and up to 13 more.
function Slug-Of([string]$s) { $t = ($s.ToLowerInvariant() -replace '[^a-z0-9]', ''); if ($t.Length -gt 13) { $t = $t.Substring(0, 13) }; return $t }

# ---------- settings files (hub.env: one KEY=value a line, UTF-8 without a byte order mark) ----------

function Read-EnvFile([string]$file) {
  $h = @{}
  if (Test-Path -LiteralPath $file) {
    $item = Get-Item -LiteralPath $file -Force
    # Read as SYSTEM: a link put in place of a person's settings must not make this read another file.
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$file is a link, not a hub's settings" }
    foreach ($l in [IO.File]::ReadAllLines($file)) { if ($l -match '^([A-Za-z0-9_]+)=(.*)$') { $h[$Matches[1]] = $Matches[2] } }
  }
  return $h
}

function Set-EnvValue([string]$file, [string]$k, [string]$v) {
  $lines = @()
  if (Test-Path -LiteralPath $file) { $lines = @([IO.File]::ReadAllLines($file)) }
  $lines = @($lines | Where-Object { -not $_.StartsWith("$k=") }) + "$k=$v"
  Write-Text $file (($lines -join "`n") + "`n")
}

# ---------- the list of people (%ProgramData%\Aeneas\people.json, the same fields as on Linux) ----------

function Read-People {
  if (-not (Test-Path -LiteralPath $RegistryFile)) { return }
  # Windows PowerShell 5.1 hands a JSON list over as one object; assigned first, then iterated, it is a list again.
  $parsed = [IO.File]::ReadAllText($RegistryFile) | ConvertFrom-Json
  foreach ($entry in @($parsed)) { $entry }
}

function Write-People($list) {
  $items = @($list)
  $json = if ($items.Count) { ConvertTo-Json -InputObject $items -Depth 4 } else { '[]' }
  Write-Text $RegistryFile ($json + "`n")
}

function Find-Person([string]$field, [string]$value) {
  foreach ($entry in @(Read-People)) { if ([string]$entry.$field -eq $value) { return $entry } }
  return $null
}

function Add-PersonEntry([string]$pName, [string]$account, [int]$port, [string]$pColor, [bool]$isOwner, [string]$address) {
  $kept = @(Read-People | Where-Object { [string]$_.user -ne $account })
  $new = [pscustomobject][ordered]@{ name = $pName; user = $account; port = $port; color = $pColor; owner = $isOwner; added = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); address = $address }
  Write-People (@($kept) + $new)
}

function Remove-PersonEntry([string]$account) { Write-People @(Read-People | Where-Object { [string]$_.user -ne $account }) }

function Next-Color {
  $used = @(Read-People | ForEach-Object { [string]$_.color })
  foreach ($c in $Palette) { if ($used -notcontains $c) { return $c } }
  return $Palette[0]
}

function Find-Tailscale {
  $t = (Get-Command tailscale.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  if (-not $t -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $t = "$env:ProgramFiles\Tailscale\tailscale.exe" }
  return $t
}

# This PC's name on the tailnet when Tailscale runs here and is signed in, else ''.
function Tailnet-Dns {
  $ts = Find-Tailscale
  if (-not $ts) { return '' }
  try {
    $st = (X $ts status --json 2>$null | Out-String) | ConvertFrom-Json
    if ($st.BackendState -eq 'Running') { return ([string]$st.Self.DNSName).TrimEnd('.') }
  } catch { }
  return ''
}

function Port-Taken([int]$port) {
  if (@(Read-People | Where-Object { [int]$_.port -eq $port }).Count) { return $true }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { return $true }
  $ts = Find-Tailscale
  if ($ts -and ((X $ts serve status 2>$null | Out-String) -match ":$port\b")) { return $true }
  return $false
}

function Next-Port { $p = $FirstPort; while (Port-Taken $p) { $p++ }; return $p }

function Wait-Health([int]$port, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3; return $true } catch { Start-Sleep -Seconds 1 }
  }
  return $false
}

# ---------- the owner ----------

function Get-OwnerInfo {
  if (-not (Test-Path -LiteralPath $OwnerInfoFile)) { Die 'this PC is not set up for several people yet: run people.ps1 setup first' }
  return ([IO.File]::ReadAllText($OwnerInfoFile) | ConvertFrom-Json)
}

function Sid-Of([string]$account) { return (New-Object Security.Principal.NTAccount $account).Translate([Security.Principal.SecurityIdentifier]).Value }

# ---------- calls to a hub on this PC, with its main key ----------

# The key is read from the hub's own settings and sent in a header to 127.0.0.1 only; the port comes from the list of
# people, never from a file the person could change.
function Hub-Call([string]$account, [string]$method, [string]$path, $body = $null) {
  $entry = Find-Person 'user' $account
  if (-not $entry) { throw "no hub for $account" }
  $envFile = if ($entry.owner) { Join-Path (Get-OwnerInfo).root 'config\hub.env' } else { Join-Path (Join-Path $PeopleRoot $account) 'config\hub.env' }
  $token = (Read-EnvFile $envFile)['EA_TOKEN']
  if (-not $token) { throw "no main key in $envFile" }
  $params = @{ UseBasicParsing = $true; Method = $method; Uri = "http://127.0.0.1:$([int]$entry.port)$path"; Headers = @{ authorization = "Bearer $token" }; TimeoutSec = 20 }
  if ($null -ne $body) { $params.ContentType = 'application/json'; $params.Body = (ConvertTo-Json -InputObject $body -Compress -Depth 5) }
  return Invoke-RestMethod @params
}

# Direct link on a person's hub (hub/src/link.ts): their phone pairs with one QR code or invitation and reaches it from
# anywhere, with no Tailscale on it. Waits until it is online.
function Use-Direct([string]$account) {
  try { $null = Hub-Call $account 'PUT' '/setup/link' @{ method = 'direct' } } catch { Note 'Direct link could not be turned on; the hub still answers on this PC and through Tailscale if it is set up'; return }
  for ($i = 0; $i -lt 30; $i++) {
    try { $v = Hub-Call $account 'GET' '/setup/link'; if ($v.direct -and [string]$v.direct.state -eq 'online') { return } } catch { }
    Start-Sleep -Seconds 1
  }
  Note 'Direct link is still starting; the invitation may not carry it yet (pair makes another later)'
}

# The person's name on their own hub, when it has none yet: their phone then opens on the app itself, not on the
# first-run Welcome steps, which someone who is not technical should not have to face.
function Name-Hub([string]$account, [string]$name) {
  try { $v = Hub-Call $account 'GET' '/setup' } catch { return }
  if ($v.named) { return }
  try { $null = Hub-Call $account 'PUT' '/profile' @{ name = $name } } catch { Note 'could not set the name on their hub' }
}

# An invitation for a person's device: works once, for 3 days, from anywhere through the Direct link.
function Get-Invitation([string]$account, [string]$deviceName) { return Hub-Call $account 'POST' '/devices/pairing' @{ name = $deviceName; days = 3 } }

# ---------- Windows: permissions, rights, tasks ----------

# Only the given SIDs get access, nothing inherited from the folder above: "*S-1-5-18:(OI)(CI)F" grants.
function Set-OnlyAccess([string]$path, [string[]]$grants) {
  $a = @($path, '/inheritance:r', '/Q')
  foreach ($g in $grants) { $a += '/grant:r'; $a += $g }
  X icacls.exe @a | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "could not set who may open $path (icacls $LASTEXITCODE)" }
}

function Add-LsaType {
  if ('AeneasLsa' -as [type]) { return }
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

// Account rights (Log on as a batch job, Deny log on locally, ...) through the LSA policy, as secpol.msc sets them.
public static class AeneasLsa {
  [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LsaAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaAttributes attributes, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr handle, byte[] sid, bool all, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint PolicyAllAccess = 0x00F0FFF;
  const uint NotFound = 0xC0000034;

  static IntPtr Open() {
    LsaAttributes a = new LsaAttributes();
    a.Length = Marshal.SizeOf(typeof(LsaAttributes));
    IntPtr h;
    uint s = LsaOpenPolicy(IntPtr.Zero, ref a, PolicyAllAccess, out h);
    if (s != 0) throw new Win32Exception(LsaNtStatusToWinError(s));
    return h;
  }
  static byte[] Bytes(string sid) {
    SecurityIdentifier id = new SecurityIdentifier(sid);
    byte[] b = new byte[id.BinaryLength];
    id.GetBinaryForm(b, 0);
    return b;
  }
  public static void Grant(string sid, string right) {
    IntPtr h = Open();
    LsaString[] r = new LsaString[1];
    r[0].Buffer = Marshal.StringToHGlobalUni(right);
    r[0].Length = (ushort)(right.Length * 2);
    r[0].MaximumLength = (ushort)(right.Length * 2 + 2);
    try {
      uint s = LsaAddAccountRights(h, Bytes(sid), r, 1);
      if (s != 0) throw new Win32Exception(LsaNtStatusToWinError(s));
    } finally { Marshal.FreeHGlobal(r[0].Buffer); LsaClose(h); }
  }
  public static void RemoveAll(string sid) {
    IntPtr h = Open();
    try {
      uint s = LsaRemoveAccountRights(h, Bytes(sid), true, null, 0);
      if (s != 0 && s != NotFound) throw new Win32Exception(LsaNtStatusToWinError(s));
    } finally { LsaClose(h); }
  }
}
'@
}

# The person's account: a password nobody knows (S4U tasks need none), allowed to run as a batch job (its hub's task)
# and nothing else: no sign-in at the screen, over Remote Desktop or from the network, and not on the sign-in screen.
function New-PersonAccount([string]$account, [string]$pName) {
  $secure = New-Object Security.SecureString
  foreach ($ch in ((New-Secret 40) + 'aA1!').ToCharArray()) { $secure.AppendChar($ch) }
  $user = New-LocalUser -Name $account -Password $secure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description "Aeneas hub for $pName"
  $sid = $user.SID.Value
  # A standard account like any other on the PC (the Users group), so Windows treats its processes normally.
  try { Add-LocalGroupMember -SID $SidUsers -Member $account -ErrorAction Stop } catch { if ($_.Exception.Message -notmatch 'already a member') { throw } }
  Add-LsaType
  [AeneasLsa]::Grant($sid, 'SeBatchLogonRight')
  foreach ($deny in @('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')) { [AeneasLsa]::Grant($sid, $deny) }
  if (-not (Test-Path $UserList)) { New-Item -Path $UserList -Force | Out-Null }
  New-ItemProperty -Path $UserList -Name $account -Value 0 -PropertyType DWord -Force | Out-Null
  return $sid
}

# A task that starts at boot and starts again after a minute when it stops, as the owner's own hub task does. Logon
# type 2 is S4U (as that account, no stored password), 5 is a service account (SYSTEM). `$sddl` says who may see,
# run and stop it besides SYSTEM and Administrators.
function Register-BootTask([string]$taskName, [string]$userName, [int]$logonType, [string]$arguments, [string]$description, [string]$readerSid = '') {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $rootFolder = $svc.GetFolder('\')
  try { $folder = $svc.GetFolder('\Aeneas') } catch { $folder = $rootFolder.CreateFolder('Aeneas') }
  $d = $svc.NewTask(0)
  $d.RegistrationInfo.Description = $description
  $d.Settings.Enabled = $true
  $d.Settings.StartWhenAvailable = $true
  $d.Settings.DisallowStartIfOnBatteries = $false
  $d.Settings.StopIfGoingOnBatteries = $false
  $d.Settings.ExecutionTimeLimit = 'PT0S'
  $d.Settings.MultipleInstances = 2
  $d.Settings.RestartInterval = 'PT1M'
  $d.Settings.RestartCount = 999
  $d.Settings.Priority = 5
  $d.Settings.IdleSettings.StopOnIdleEnd = $false
  $null = $d.Triggers.Create(8)
  $act = $d.Actions.Create(0)
  $act.Path = 'powershell.exe'
  $act.Arguments = $arguments
  $d.Principal.UserId = $userName
  $d.Principal.LogonType = $logonType
  $d.Principal.RunLevel = 0
  $sddl = 'D:(A;;FA;;;SY)(A;;FA;;;BA)'
  if ($readerSid) { $sddl += "(A;;GRGWGX;;;$readerSid)" }
  $null = $folder.RegisterTaskDefinition($taskName, $d, 6, $userName, $null, $logonType, $sddl)
}

function Find-Task([string]$taskName) { Get-ScheduledTask -TaskPath $TaskFolder -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Start-Task([string]$taskName) { $t = Find-Task $taskName; if ($t) { $t | Start-ScheduledTask } }
function Stop-Task([string]$taskName) { $t = Find-Task $taskName; if ($t -and $t.State -eq 'Running') { $t | Stop-ScheduledTask; Start-Sleep -Seconds 2 } }
function Remove-Task([string]$taskName) { $t = Find-Task $taskName; if ($t) { Stop-Task $taskName; $t | Unregister-ScheduledTask -Confirm:$false } }
function Person-Task([string]$account) { return "Aeneas hub ($account)" }

function Service-Arguments([string]$runner, [string]$root) {
  return "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Root `"$root`""
}

# ---------- a person's hub ----------

function Person-Root([string]$account) { return Join-Path $PeopleRoot $account }

# The owner's code and Node, copied as they are installed (packages included: no network, no compiler). Not copied:
# git history, the owner's data and settings, the Apple and app-build folders, and an offline reference library kept
# inside the code's folder.
function Copy-Code([string]$account) {
  $o = Get-OwnerInfo
  $ownerApp = Join-Path $o.root 'app'
  $root = Person-Root $account
  $skipDirs = @('.git', 'hub\data', 'analysis', 'web\src-tauri', 'web\node_modules', 'apple', 'design', '.update-backup') | ForEach-Object { Join-Path $ownerApp $_ }
  $ref = (Read-EnvFile (Join-Path $o.root 'config\hub.env'))['EA_REFERENCE_DIR']
  if ($ref) {
    $ref = $ref.Trim('"')
    $full = if ([IO.Path]::IsPathRooted($ref)) { $ref } else { [IO.Path]::GetFullPath((Join-Path (Join-Path $ownerApp 'hub') $ref)) }
    if ($full.StartsWith($ownerApp + '\', [StringComparison]::OrdinalIgnoreCase)) { $skipDirs += $full.TrimEnd('\') }
  }
  $skipFiles = @('.env', 'hub\.env') | ForEach-Object { Join-Path $ownerApp $_ }
  Mirror $ownerApp (Join-Path $root 'app') @($skipDirs) @($skipFiles) $account
  Mirror (Join-Path $o.root 'node') (Join-Path $root 'node') @() @() $account
}

# One folder made the same as another. /XJ: junctions are not followed; /MIR: files gone from the source go here too;
# /XD and /XF: full paths left out.
function Mirror([string]$src, [string]$dest, [string[]]$skipDirs, [string[]]$skipFiles, [string]$account) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $a = @($src, $dest, '/MIR', '/XJ', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($skipDirs.Count) { $a += '/XD'; $a += $skipDirs }
  if ($skipFiles.Count) { $a += '/XF'; $a += $skipFiles }
  X robocopy.exe @a | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "copying $src for $account failed (robocopy $LASTEXITCODE)" }
}

# Held: the person's service stops the hub and keeps it stopped while the code is replaced (hub-service.ps1 reads
# run\hold-hub), as the installer and the updater do for the owner's.
function Hold-Hub([string]$root) {
  $run = Join-Path $root 'run'
  New-Item -ItemType Directory -Force -Path $run | Out-Null
  [IO.File]::WriteAllText((Join-Path $run 'hold-hub'), '')
  $pidFile = Join-Path $run 'hub.pid'
  for ($i = 0; $i -lt 30 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
}
function Release-Hub([string]$root) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path (Join-Path $root 'run') 'hold-hub') }

# Everything an account runs stopped, then the account, its rights, its sign-in screen entry, its profile and its hub
# folder deleted.
function Erase-Account([string]$account) {
  Remove-Task (Person-Task $account)
  $sid = $null
  try { $sid = Sid-Of $account } catch { }
  if ($sid) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
      try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop; if ($o.Sid -eq $sid) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch { }
    }
    Add-LsaType
    try { [AeneasLsa]::RemoveAll($sid) } catch { Note "its account rights could not be removed: $($_.Exception.Message)" }
    Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $sid } | Remove-CimInstance -ErrorAction SilentlyContinue
  }
  if (Get-LocalUser -Name $account -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $account }
  Remove-ItemProperty -Path $UserList -Name $account -ErrorAction SilentlyContinue
  $root = Person-Root $account
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if (Get-LocalUser -Name $account -ErrorAction SilentlyContinue) { Die "could not delete the account $account" }
}

# ---------- commands ----------

function Do-Setup {
  Assert-Admin
  $ownerAccount = if ($Owner) { $Owner } else { $env:USERNAME }
  $ownerAccount = ($ownerAccount -split '\\')[-1]
  try { $ownerSid = Sid-Of $ownerAccount } catch { Die "there is no account named $ownerAccount on this PC (give -Owner <the account your hub runs as>)" }
  $root = $OwnerRoot
  if (-not $root) {
    $profile_ = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $ownerSid } | Select-Object -First 1
    if (-not $profile_) { Die "no Windows profile for ${ownerAccount}: sign in to it once, or give -OwnerRoot <the hub's folder>" }
    $root = Join-Path $profile_.LocalPath 'AppData\Local\AeneasHub'
  }
  $ownerEnv = Join-Path $root 'config\hub.env'
  if (-not (Test-Path -LiteralPath $ownerEnv)) { Die "no hub at ${root}: install your hub first (deploy\install.ps1), or give -OwnerRoot" }
  $cfg = Read-EnvFile $ownerEnv
  $pName = if ($Name) { $Name } elseif ($cfg['EA_HUB_NAME']) { $cfg['EA_HUB_NAME'] } else { '' }
  if (-not $pName) { Die 'give -Name <your name>, shown on your devices' }
  if (-not (Valid-Name $pName)) { Die 'a name is letters, up to 30' }
  if ($Color -and -not (Valid-Color $Color)) { Die 'a color is #rrggbb, like #2f8f83' }
  $ownerPort = if ($cfg['EA_PORT']) { [int]$cfg['EA_PORT'] } else { 8787 }
  $upstream = [string]$cfg['EA_OLLAMA_URL']
  if (-not $upstream -or $upstream -eq $GateUrl) { $upstream = [string]$cfg['EA_GATE_UPSTREAM'] }
  if (-not $upstream) { Die 'your hub has no model server yet; pick a model on its Welcome page first' }
  $node = Join-Path $root 'node\node.exe'
  if (-not (Test-Path -LiteralPath $node)) { Die "no Node at $node" }

  Say 'Folders for the list of people, requests and results'
  New-Item -ItemType Directory -Force -Path $Base, $RequestDir, $ResultDir, $PeopleRoot | Out-Null
  # Everyone reads the list of people (a person's hub reads it to know it follows the owner's updates); only SYSTEM and
  # administrators write it. The owner drops requests and reads results; nobody else sees either.
  Set-OnlyAccess $Base @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F", "*${SidUsers}:(OI)(CI)RX")
  Set-OnlyAccess $RequestDir @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F", "*${ownerSid}:(OI)(CI)M")
  Set-OnlyAccess $ResultDir @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F", "*${ownerSid}:(OI)(CI)RX")
  Set-OnlyAccess $PeopleRoot @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F")

  Say "Model gate on 127.0.0.1:$GatePort in front of $upstream"
  $gateRoot = Join-Path $root 'gate'
  New-Item -ItemType Directory -Force -Path (Join-Path $gateRoot 'config'), (Join-Path $gateRoot 'run'), (Join-Path $gateRoot 'data\logs') | Out-Null
  $slots = if ($env:EA_GATE_SLOTS -match '^\d+$') { $env:EA_GATE_SLOTS } else { '1' }
  $gate = [ordered]@{ name = 'gate'; file = $node; args = @('--import', 'tsx', 'src/main.ts', 'gate'); cwd = (Join-Path $root 'app\hub'); env = [ordered]@{ EA_GATE_PORT = "$GatePort"; EA_GATE_UPSTREAM = $upstream; EA_GATE_SLOTS = $slots; EA_GATE_MODELS = [string]$cfg['EA_OLLAMA_MODEL']; 'PATH+' = (Join-Path $root 'node') } }
  Write-Text (Join-Path $gateRoot 'config\services.json') ((ConvertTo-Json -InputObject @($gate) -Depth 5) + "`n")
  # Its own task (the owner's hub-service.ps1 with a folder of its own), so the hub installer, which writes the hub's
  # services.json afresh each run, never drops it.
  Register-BootTask $GateTask $ownerAccount 2 (Service-Arguments (Join-Path $root 'app\deploy\windows\hub-service.ps1') $gateRoot) 'Shares the model server between the Aeneas hubs on this PC. Made by deploy\windows\people.ps1 setup.' $ownerSid
  Stop-Task $GateTask; Start-Task $GateTask
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) { try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$GateUrl/gate/status" -TimeoutSec 2; $ok = $true } catch { Start-Sleep -Seconds 1 } }
  if (-not $ok) { Die "the gate did not start; see $gateRoot\data\logs\gate.log" }
  try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$GateUrl/api/version" -TimeoutSec 5 } catch { Die "the gate is up but the model server at $upstream does not answer through it" }

  Say 'The task that lets your hub add people from the app'
  New-Item -ItemType Directory -Force -Path $RootCopyDir | Out-Null
  # Only administrators and SYSTEM may change the copy that runs as SYSTEM.
  Set-OnlyAccess $RootCopyDir @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F", "*${SidUsers}:(OI)(CI)RX")
  Copy-Item -Force -LiteralPath $PSCommandPath -Destination $RootCopy
  [IO.File]::WriteAllText($OwnerFile, $ownerAccount, $Utf8)
  Write-Text $OwnerInfoFile (ConvertTo-Json -InputObject ([ordered]@{ user = $ownerAccount; sid = $ownerSid; root = $root }) -Compress)
  Register-BootTask $PeopleTask 'SYSTEM' 5 "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RootCopy`" watch" "Adds the people $ownerAccount's Aeneas hub asks for. Made by deploy\windows\people.ps1 setup."
  Stop-Task $PeopleTask; Start-Task $PeopleTask

  Say "Your hub ($pName)"
  $hubColor = if ($Color) { $Color } elseif ($cfg['EA_HUB_COLOR']) { $cfg['EA_HUB_COLOR'] } else { '' }
  if (-not $hubColor) { $known = Find-Person 'user' $ownerAccount; if ($known) { $hubColor = [string]$known.color } }
  if (-not $hubColor) { $hubColor = Next-Color }
  # On Windows the owner's hub keeps talking to the model server itself (the gate cannot tell the hubs apart here, so
  # it would not let the owner add or remove models through it). The gate is for everyone else's hubs.
  Set-EnvValue $ownerEnv 'EA_GATE_UPSTREAM' $upstream
  Set-EnvValue $ownerEnv 'EA_HUB_NAME' $pName
  Set-EnvValue $ownerEnv 'EA_HUB_COLOR' $hubColor
  Hold-Hub $root; Release-Hub $root
  if (-not (Wait-Health $ownerPort)) { Die "your hub did not come back on port $ownerPort; see $root\data\logs\hub.log" }
  $dns = Tailnet-Dns
  Add-PersonEntry $pName $ownerAccount $ownerPort $hubColor $true $(if ($dns -and ([string]$cfg['EA_PUBLIC_URL']) -match '\.ts\.net') { [string]$cfg['EA_PUBLIC_URL'] } else { '' })
  Set-Result 'done'
  Write-Host ''
  Write-Host "Done. Open Settings, People on this machine in the app to add someone."
}

function Do-Unsetup {
  Assert-Admin
  if (@(Read-People | Where-Object { -not $_.owner }).Count) { Die 'remove the other people first (people.ps1 remove <name>)' }
  $o = $null
  if (Test-Path -LiteralPath $OwnerInfoFile) { $o = Get-OwnerInfo }
  Remove-Task $PeopleTask
  Remove-Task $GateTask
  if ($o) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $o.root 'gate') }
  Remove-Item -Force -ErrorAction SilentlyContinue $RootCopy, $OwnerFile, $OwnerInfoFile, $RegistryFile
  Write-Host 'The gate and the people task are gone. Your hub keeps its name and color.'
}

function Do-Add([string]$pName, [string]$pColor) {
  Assert-Admin
  if (-not (Valid-Name $pName)) { Die "give the person's name (letters, up to 30)" }
  $o = Get-OwnerInfo
  try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$GateUrl/gate/status" -TimeoutSec 2 } catch { Die 'the model gate is not running: run setup again' }
  $slug = Slug-Of $pName
  if (-not $slug) { Die 'that name gives no account name' }
  $account = "aeneas-$slug"
  if (Find-Person 'user' $account) { Die "$pName already has a hub" }
  if (@(Read-People | Where-Object { ([string]$_.name).ToLowerInvariant() -eq $pName.ToLowerInvariant() }).Count) { Die "someone named $pName already has a hub" }
  if (Get-LocalUser -Name $account -ErrorAction SilentlyContinue) { Die "the account $account already exists (a hub stopped earlier keeps it); pick another name, or delete it with: people.ps1 remove-account $account -Erase $account" }
  if ($pColor -and -not (Valid-Color $pColor)) { Die 'a color is #rrggbb' }
  if (-not $pColor) { $pColor = Next-Color }
  $port = Next-Port
  $dns = Tailnet-Dns
  $address = if ($dns) { "https://$dns`:$port" } else { '' }
  $root = Person-Root $account
  Set-Result 'working' @{ name = $pName; color = $pColor; address = $address; account = $account }

  Say "Making an account for $pName"
  $sid = New-PersonAccount $account $pName
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  # Their folder is theirs: that account, SYSTEM and administrators, nobody else (not the owner's account either).
  Set-OnlyAccess $root @("*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F", "*${sid}:(OI)(CI)F")
  foreach ($dir in @('config', 'data', 'data\vault', 'data\backups', 'data\logs', 'run')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $dir) | Out-Null }

  Say "Copying the hub's code"
  Copy-Code $account

  Say "Settings for $pName's hub"
  $ownerCfg = Read-EnvFile (Join-Path $o.root 'config\hub.env')
  $envFile = Join-Path $root 'config\hub.env'
  $lines = @('# Aeneas hub settings for one person on this PC (deploy\windows\people.ps1).',
    "EA_PORT=$port", 'EA_BIND_HOST=127.0.0.1', "EA_PUBLIC_URL=$address", "EA_TOKEN=$(New-Secret 48)",
    "EA_DATA_DIR=$root\data", "EA_VAULT_DIR=$root\data\vault", "EA_BACKUP_DIR=$root\data\backups", "EA_WORK_KEY_FILE=$root\config\work.key",
    'EA_ALLOW_CLOUD_DEFAULT=false', 'EA_NO_DOTENV=1', 'EA_LINK=direct',
    "EA_HUB_NAME=$pName", "EA_HUB_COLOR=$pColor", "EA_OWNER_NAME=$pName",
    # This PC's disks and temperatures are the owner's business, and this account has no keys to anyone's machines.
    'EA_HOST_SENSORS=false', "EA_OLLAMA_URL=$GateUrl")
  foreach ($k in $SharedKeys) { if ($ownerCfg[$k]) { $lines += "$k=$($ownerCfg[$k])" } }
  # The background reader waits for a button, as on the owner's hub when it has no setting (the GPU may be gaming).
  if (-not $ownerCfg['EA_BACKGROUND_AI']) { $lines += 'EA_BACKGROUND_AI=ask' }
  Write-Text $envFile (($lines -join "`n") + "`n")
  $svc = [ordered]@{ name = 'hub'; file = (Join-Path $root 'node\node.exe'); args = @("--env-file=$envFile", '--import', 'tsx', 'src/main.ts', 'serve'); cwd = (Join-Path $root 'app\hub'); env = [ordered]@{ 'PATH+' = (Join-Path $root 'node') } }
  Write-Text (Join-Path $root 'config\services.json') ((ConvertTo-Json -InputObject @($svc) -Depth 5) + "`n")
  # The starter content (plan rules, checklists), as the installer does once for a new hub.
  Push-Location (Join-Path $root 'app\hub')
  try { X (Join-Path $root 'node\node.exe') "--env-file=$envFile" --import tsx src/main.ts seed | Out-Null } finally { Pop-Location }

  Say "Starting $pName's hub"
  # Listed first, so Hub-Call finds the port; taken off again if it does not start.
  Add-PersonEntry $pName $account $port $pColor $false $address
  Register-BootTask (Person-Task $account) $account 2 (Service-Arguments (Join-Path $root 'app\deploy\windows\hub-service.ps1') $root) "Runs $pName's Aeneas hub from boot. Made by deploy\windows\people.ps1."
  Start-Task (Person-Task $account)
  if (-not (Wait-Health $port 90)) {
    Remove-PersonEntry $account
    Die "$pName's hub did not start (see $root\data\logs\hub.log); the account $account is left as it is (people.ps1 remove-account $account -Erase $account to start over)"
  }
  if ($dns) {
    Say "Giving $pName's hub its address on your tailnet"
    X (Find-Tailscale) serve --bg "--https=$port" "http://127.0.0.1:$port" 2>$null | Out-Null
  }
  Say "Making $pName's hub reachable with a QR code, from anywhere"
  Use-Direct $account
  Name-Hub $account $pName
  $pairing = $null
  try { $pairing = Get-Invitation $account "$pName's phone" } catch { Note "no invitation yet: $($_.Exception.Message)" }
  Set-Result 'done' @{ pairing = $(if ($pairing) { $pairing } else { [ordered]@{} }); note = $AdminNote }
  Write-Host ''
  Write-Host "$pName's hub is ready"
  Note "port     $port$(if ($address) { "  ($address)" })"
  Note "color    $pColor"
  Note "account  $account (data in $root, open to that account and this PC's administrators)"
  if ($pairing) {
    Write-Host ''
    Write-Host 'First device (works once, for 3 days; people.ps1 pair makes another):'
    Note "Code: $($pairing.code)"
    Note "App:  $($pairing.app)"
  }
  Write-Host ''
  Write-Host 'Their phone reaches this hub through the Direct link in that invitation, from anywhere, with nothing else to install.'
  Write-Host $AdminNote
}

function Do-Pair([string]$pName) {
  Assert-Admin
  $entry = Find-Person 'name' $pName
  if (-not $entry -or $entry.owner) { Die "no hub for $pName (see: people.ps1 list)" }
  # A hub added before Direct link was offered gets it now, so the new invitation works from anywhere.
  Use-Direct ([string]$entry.user)
  Name-Hub ([string]$entry.user) $pName
  try { $pairing = Get-Invitation ([string]$entry.user) "$pName's device" } catch { Die "$pName's hub did not answer" }
  Set-Result 'done' @{ name = $pName; pairing = $pairing }
  Write-Host "Works once, for 3 days. Code: $($pairing.code)"
  Note "App: $($pairing.app)"
}

# The owner offers to help this person with their devices (hub/src/helpers.ts): their hub keeps the offer, with only
# the SHA-256 of the key the owner's hub made, until they say yes in their app. Nothing secret passes through here.
function Do-Ward([string]$pName) {
  Assert-Admin
  $entry = Find-Person 'name' $pName
  if (-not $entry -or $entry.owner) { Die "no hub for $pName (see: people.ps1 list)" }
  if (-not (Valid-Name $Helper)) { Die 'give -Helper <your name>' }
  if ($Hash -cnotmatch '^[0-9a-f]{64}$') { Die "give -Hash <the key's sha256>" }
  try { $offer = Hub-Call ([string]$entry.user) 'POST' '/helpers/offer' @{ name = $Helper; key_hash = $Hash } } catch { Die "$pName's hub did not take the offer (is it running and up to date?)" }
  Set-Result 'done' @{ name = $pName; offer = $offer }
  Write-Host "Offered. $pName says yes or no in their app."
}

function Do-List {
  if (-not (Test-Path -LiteralPath $RegistryFile)) { Die 'no people yet: run setup' }
  '{0,-16} {1,-20} {2,-7} {3,-8} {4,-8} {5}' -f 'NAME', 'ACCOUNT', 'PORT', 'COLOR', 'STATE', 'ADDRESS'
  foreach ($entry in @(Read-People)) {
    $state = 'down'
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$([int]$entry.port)/health" -TimeoutSec 3; $state = 'up' } catch { }
    '{0,-16} {1,-20} {2,-7} {3,-8} {4,-8} {5}' -f "$($entry.name)$(if ($entry.owner) { ' (owner)' })", $entry.user, $entry.port, $entry.color, $state, $entry.address
  }
  $gs = 'not running'
  try { $g = Invoke-RestMethod -UseBasicParsing -Uri "$GateUrl/gate/status" -TimeoutSec 3; $gs = "$(@($g.running).Count) running, $(@($g.waiting).Count) waiting, $($g.slots) place(s)" } catch { }
  ''
  "gate: $gs"
}

function Do-Update {
  Assert-Admin
  if (-not (Test-Path -LiteralPath $RegistryFile)) { Die 'no people yet' }
  # The SYSTEM copy follows your current code when you run this yourself, elevated (so you chose to). A request from
  # your hub (its own update finished) does not: code your account can change never becomes the script SYSTEM runs.
  if (-not $ResultFile -and $PSCommandPath -ne $RootCopy -and (Test-Path -LiteralPath $RootCopyDir)) { Copy-Item -Force -LiteralPath $PSCommandPath -Destination $RootCopy }
  foreach ($entry in @(Read-People | Where-Object { -not $_.owner })) {
    $account = [string]$entry.user
    Say "$($entry.name) ($account, port $($entry.port))"
    $root = Person-Root $account
    Hold-Hub $root
    try { Copy-Code $account } finally { Release-Hub $root }
    if (Wait-Health ([int]$entry.port) 90) { Note 'up' } else { Note "DID NOT COME BACK: see $root\data\logs\hub.log" }
  }
  # The gate runs the owner's code: started again on the new version, still limited to the owner's model.
  $o = Get-OwnerInfo
  $gateFile = Join-Path $o.root 'gate\config\services.json'
  if (Test-Path -LiteralPath $gateFile) {
    $model = (Read-EnvFile (Join-Path $o.root 'config\hub.env'))['EA_OLLAMA_MODEL']
    $parsed = [IO.File]::ReadAllText($gateFile) | ConvertFrom-Json
    $specs = @(foreach ($s in @($parsed)) { $s })
    foreach ($s in $specs) { if ($s.name -eq 'gate' -and $s.env) { $s.env.EA_GATE_MODELS = [string]$model } }
    Write-Text $gateFile ((ConvertTo-Json -InputObject $specs -Depth 5) + "`n")
  }
  Stop-Task $GateTask; Start-Task $GateTask
  Set-Result 'done'
}

function Do-Remove([string]$pName, [bool]$stopOnly) {
  Assert-Admin
  $entry = Find-Person 'name' $pName
  if (-not $entry) { Die "no hub for $pName" }
  if ($entry.owner) { Die 'that is your own hub' }
  if ($Erase -and $Erase -ne $pName) { Die "-Erase needs the name again, exactly: -Erase `"$pName`"" }
  $account = [string]$entry.user
  $port = [int]$entry.port
  Remove-Task (Person-Task $account)
  $ts = Find-Tailscale
  if ($ts) { X $ts serve "--https=$port" off 2>$null | Out-Null }
  Remove-PersonEntry $account
  if ($Erase -and -not $stopOnly) {
    Erase-Account $account
    Say "$pName's hub, account and data are deleted"
  } else {
    Disable-LocalUser -Name $account -ErrorAction SilentlyContinue
    Write-Host "$pName's hub is stopped. Their data stays in $(Person-Root $account) (account $account, disabled)."
    Note "To delete it for good: people.ps1 remove-account $account -Erase $account"
  }
  Set-Result 'done' @{ name = $pName; account = $account }
}

function Do-RemoveAccount([string]$account) {
  Assert-Admin
  if ($Erase -ne $account) { Die 'usage: people.ps1 remove-account <account> -Erase <account>' }
  if ($account -cnotmatch '^aeneas-[a-z0-9]{1,13}$') { Die 'only aeneas-* accounts' }
  if (Find-Person 'user' $account) { Die "$account still has a hub: remove it first" }
  if (-not (Get-LocalUser -Name $account -ErrorAction SilentlyContinue)) { Die "no account $account" }
  Erase-Account $account
  Say "account $account and its data are deleted"
}

# One request the owner's hub dropped, checked field by field: an id, one of five words, a person's name, a color,
# and for ward the owner's name and a key's hash. Anything else, or a file that is a link or too long, is dropped.
function Read-Request([string]$file) {
  try {
    $item = Get-Item -LiteralPath $file -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $null }
    if ($item.Length -gt 4096) { return $null }
    $r = [IO.File]::ReadAllText($file) | ConvertFrom-Json
  } catch { return $null }
  $rid = [string]$r.id; $op = [string]$r.op; $pName = [string]$r.name; $pColor = [string]$r.color; $pHelper = [string]$r.helper; $pHash = [string]$r.hash
  if ($rid -cnotmatch '^[a-z0-9-]{8,40}$') { return $null }
  $named = Valid-Name $pName
  $ok = (($op -ceq 'add' -or $op -ceq 'pair' -or $op -ceq 'stop') -and $named -and ($pColor -eq '' -or (Valid-Color $pColor)) -and $pHelper -eq '' -and $pHash -eq '') -or
        ($op -ceq 'ward' -and $named -and $pColor -eq '' -and (Valid-Name $pHelper) -and ($pHash -cmatch '^[0-9a-f]{64}$')) -or
        ($op -ceq 'update' -and $pName -eq '' -and $pColor -eq '' -and $pHelper -eq '' -and $pHash -eq '')
  if (-not $ok) { return $null }
  return [ordered]@{ id = $rid; op = $op; name = $pName; color = $pColor; helper = $pHelper; hash = $pHash }
}

# Run by the SYSTEM task for each request. Each one in its own PowerShell, so one that fails does not stop the
# others; what it is for goes in the environment, never on a command line (where Windows PowerShell 5.1 would drop
# quotes from a name like O'Neil).
function Do-ServeRequests {
  Get-ChildItem -LiteralPath $ResultDir -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($f in @(Get-ChildItem -LiteralPath $RequestDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)) {
    $req = Read-Request $f.FullName
    if (-not $req) { Remove-Item -Force -LiteralPath $f.FullName -ErrorAction SilentlyContinue; continue }
    $result = Join-Path $ResultDir "$($req.id).json"
    # The result exists before the request goes, so the hub never sees neither.
    [IO.File]::WriteAllText($result, (ConvertTo-Json -InputObject ([ordered]@{ state = 'working'; op = $req.op; name = $req.name }) -Compress), $Utf8)
    Remove-Item -Force -LiteralPath $f.FullName
    $env:EA_PEOPLE_RESULT = $result
    $env:EA_PEOPLE_OP = $req.op; $env:EA_PEOPLE_NAME = $req.name; $env:EA_PEOPLE_COLOR = $req.color
    $env:EA_PEOPLE_HELPER = $req.helper; $env:EA_PEOPLE_HASH = $req.hash
    try {
      $p = Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RootCopy`" run-request" -WindowStyle Hidden -PassThru
      # Windows PowerShell 5.1 keeps a process's exit code only while its handle is held.
      $null = $p.Handle
      if (-not $p.WaitForExit(30 * 60 * 1000)) { try { $p.Kill() } catch { }; Set-ResultAt $result 'failed' 'it took more than 30 minutes' }
    } catch { Set-ResultAt $result 'failed' $_.Exception.Message }
    foreach ($k in @('EA_PEOPLE_RESULT', 'EA_PEOPLE_OP', 'EA_PEOPLE_NAME', 'EA_PEOPLE_COLOR', 'EA_PEOPLE_HELPER', 'EA_PEOPLE_HASH')) { Remove-Item -ErrorAction SilentlyContinue "env:$k" }
  }
}

function Set-ResultAt([string]$file, [string]$state, [string]$err) {
  try { [IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject ([ordered]@{ state = $state; error = $err }) -Compress), $Utf8) } catch { }
}

# One request, already checked, as the SYSTEM task hands it over (Do-ServeRequests).
function Do-RunRequest {
  $op = [string]$env:EA_PEOPLE_OP
  $pName = [string]$env:EA_PEOPLE_NAME
  switch -CaseSensitive ($op) {
    'add' { Do-Add $pName ([string]$env:EA_PEOPLE_COLOR) }
    'pair' { Do-Pair $pName }
    'stop' { Do-Remove $pName $true }
    'ward' { $script:Helper = [string]$env:EA_PEOPLE_HELPER; $script:Hash = [string]$env:EA_PEOPLE_HASH; Do-Ward $pName }
    'update' { Do-Update }
    default { Die 'unknown request' }
  }
}

# The SYSTEM task's loop: a look at the request folder every few seconds.
function Do-Watch {
  while ($true) {
    try { if (@(Get-ChildItem -LiteralPath $RequestDir -Filter '*.json' -ErrorAction SilentlyContinue).Count) { Do-ServeRequests } } catch { }
    Start-Sleep -Seconds 3
  }
}

try {
  switch -CaseSensitive ($Command) {
    'setup' { Do-Setup }
    'unsetup' { Do-Unsetup }
    'add' { Do-Add $Who $Color }
    'pair' { Do-Pair $Who }
    'ward' { Do-Ward $Who }
    'list' { Do-List }
    'update' { Do-Update }
    'stop' { Do-Remove $Who $true }
    'remove' { Do-Remove $Who $false }
    'remove-account' { Do-RemoveAccount $Who }
    'serve-requests' { Assert-Admin; Do-ServeRequests }
    'run-request' { Assert-Admin; Do-RunRequest }
    'watch' { Assert-Admin; Do-Watch }
    default { Get-Help $PSCommandPath; exit 2 }
  }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($ResultFile -and -not ((Test-Path -LiteralPath $ResultFile) -and (([IO.File]::ReadAllText($ResultFile)) -match '"state":"failed"'))) { Set-Result 'failed' @{ error = $_.Exception.Message } }
  exit 1
}
