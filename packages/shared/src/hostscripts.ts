/**
 * The read-only scripts that read a machine's CPU, memory, disks, temperatures, GPUs, pools and OS (Tech, Module 4
 * and 6). The hub runs them on the machines it signs in to (hub/src/hostsensors.ts), and the Windows app runs the
 * Windows one on its own computer when it reports that computer itself (PUT /devices/me/computer), so both read the
 * same way. Each prints lines the hub parses: `cpu <percent>`, `mem <percent>`, `disk <mount> <percent>`,
 * `temp <kind> <millidegrees>`, `gpu <index>, <temp>, <used MiB>, <total MiB>`, `pool <name> <cap%> <health>`,
 * `os <what it runs>`.
 */

const LINUX = [
  // CPU busy over 2 seconds (idle and iowait count as not busy), and memory in use (what MemAvailable says cannot be had back).
  // printf, not print: Debian's mawk prints a sum past 2^31 as "3.76343e+09", so on a machine up for weeks both samples
  // read the same and the CPU line was lost.
  `a=$(awk '/^cpu /{printf "%.0f %.0f\\n", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit}' /proc/stat 2>/dev/null); sleep 2; b=$(awk '/^cpu /{printf "%.0f %.0f\\n", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit}' /proc/stat 2>/dev/null); echo "$a $b" | awk 'NF==4 {t=$3-$1; if (t>0) printf "cpu %.1f\\n", 100*(1-($4-$2)/t)}'`,
  `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END {if (t>0 && a!="") printf "mem %.1f\\n", 100*(t-a)/t}' /proc/meminfo 2>/dev/null`,
  // Disks, without pseudo and ZFS file systems (the pool line covers those) or boot partitions.
  `df -PT 2>/dev/null | awk 'NR>1 && $2 !~ /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|vfat|zfs|fuse.*|nfs.*|cifs)$/ && $7 !~ /^\\/(boot|snap|run|dev|sys|proc)/ {gsub("%","",$6); print "disk", $7, $6}'`,
  `for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); case "$n" in coretemp|k10temp|zenpower|cpu_thermal|nvme) t=$(cat "$h/temp1_input" 2>/dev/null) && echo "temp $n $t";; esac; done`,
  `command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu /'`,
  `command -v zpool >/dev/null 2>&1 && zpool list -H -o name,cap,health 2>/dev/null | sed 's/^/pool /'`,
  // What the machine says it runs (machineinfo.ts): Proxmox, UniFi and QNAP devices name themselves; else os-release.
  // A Proxmox host also reads its guests: each VM's status (CPU, and memory as the guest's balloon driver reports it),
  // its disks and OS through the QEMU guest agent where one is set up, and its containers. Read-only.
  `if command -v pvesh >/dev/null 2>&1; then n=$(hostname -s); for id in $(pvesh get /nodes/$n/qemu --output-format json 2>/dev/null | grep -o '"vmid":[0-9]*' | cut -d: -f2); do s=$(pvesh get /nodes/$n/qemu/$id/status/current --output-format json 2>/dev/null); echo "pvevm $s"; case "$s" in *'"agent":1'*'"status":"running"'*|*'"status":"running"'*'"agent":1'*) echo "pvefs $id $(timeout 5 qm guest cmd $id get-fsinfo 2>/dev/null | tr -d '\\n')"; echo "pveos $id $(timeout 5 qm guest cmd $id get-osinfo 2>/dev/null | tr -d '\\n')";; esac; done; echo "pvelxc $(pvesh get /nodes/$n/lxc --output-format json 2>/dev/null)"; fi`,
  `if command -v pveversion >/dev/null 2>&1; then echo "os Proxmox VE $(pveversion 2>/dev/null | sed -n 's#^pve-manager/\\([^/]*\\).*#\\1#p')"; elif command -v ubnt-device-info >/dev/null 2>&1; then echo "os $(ubnt-device-info model 2>/dev/null), firmware $(ubnt-device-info firmware 2>/dev/null)"; elif command -v getsysinfo >/dev/null 2>&1 && command -v getcfg >/dev/null 2>&1; then echo "os QNAP $(getsysinfo model 2>/dev/null), firmware $(getcfg System Version 2>/dev/null)"; elif [ -r /etc/os-release ]; then echo "os $(. /etc/os-release; printf %s "$PRETTY_NAME")"; fi`,
  "true",
].join("\n");

const MACOS = [
  // CPU from top's second sample (the first is since boot); memory from the system's own free percentage.
  `top -l 2 -n 0 -s 1 2>/dev/null | awk '/CPU usage/ {i=$7} END {if (i!="") {gsub("%","",i); printf "cpu %.1f\\n", 100-i}}'`,
  `memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/ {gsub("%","",$2); printf "mem %.1f\\n", 100-$2}'`,
  `df -P /System/Volumes/Data 2>/dev/null | awk 'NR>1 {gsub("%","",$5); print "disk / " $5}'`,
  `echo "os $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"`,
  "true",
].join("\n");

const WINDOWS = [
  // Numbers are written with a dot whatever the machine's language (with -f, a German Windows wrote 89,3 and the hub read 89).
  "$inv = [Globalization.CultureInfo]::InvariantCulture",
  `$c = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; if ($c -ne $null) { [string]::Format($inv, 'cpu {0}', [math]::Round([double]$c, 1)) }`,
  `$o = Get-CimInstance Win32_OperatingSystem; if ($o.Caption) { 'os ' + ($o.Caption -replace '^Microsoft\\s+', '') }; if ($o.TotalVisibleMemorySize -gt 0) { [string]::Format($inv, 'mem {0}', [math]::Round(100 * ($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) / $o.TotalVisibleMemorySize, 1)) }`,
  `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { if ($_.Size -gt 0) { [string]::Format($inv, 'disk {0} {1}', $_.DeviceID.TrimEnd(':'), [math]::Round(100 * ($_.Size - $_.FreeSpace) / $_.Size, 1)) } }`,
  `if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=index,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits | ForEach-Object { 'gpu ' + $_ } }`,
  "",
].join("\n");

export const HOST_SCRIPTS = { linux: LINUX, macos: MACOS, windows: WINDOWS } as const;
