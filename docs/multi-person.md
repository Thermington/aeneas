# Several people on one hub machine

Aeneas keeps one person per hub. When several people (a household, say) want to use one machine, each gets a hub of their own on it. Nothing is shared between their hubs but the model server, and that is shared fairly.

This works on a Linux hub with Tailscale, and on a Windows hub (with or without Tailscale). Each person's phone reaches their hub with one QR code or invitation, from anywhere, through the Direct link; someone who uses Tailscale can use the hub's address on your tailnet instead.

## Who can see what

- **The other people on the machine cannot see your hub.** Each hub runs in its own account (a Linux account, or a Windows account on a Windows PC), and its files (database, notes, chats, keys, backups) can be read only by that account. One person's hub cannot open another's, and neither can the hubs' assistants.
- **The machine's admin can.** Anyone with admin rights on the machine (root or sudo on Linux, an administrator on Windows) can read every account's files, and that usually means the machine's owner. The app says so on the People on this machine screen, before and after someone is added. Tell the people you add before they start, and share a machine only with people who trust whoever runs it.

## Adding someone

**Once, on the hub's machine.** On Linux, run this command in a terminal. It asks for your password and takes a minute.

```bash
sudo bash ~/everythingapp/deploy/people.sh setup --name "Your name"
```

On Windows, paste the line the app shows (Settings, People on this machine) into a PowerShell window; Windows asks once for permission (an administrator). It runs this, with your account and hub folder filled in:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\people.ps1" setup -Owner $env:USERNAME -Name "Your name"
```

It sets up three things:

- the model gate, which shares the model;
- your own hub, sent through the gate and given a color (on Windows your own hub keeps talking to the model server directly: see Limits);
- a small service that lets your hub add people from the app.

Until it has run, the app's People on this machine screen shows this command.

**Each person, in the app.**

1. Open Settings, People on this machine. Type their first name and press Add. It takes a minute or two, and the screen shows each step.
2. When it's ready, the screen shows their hub's color and an invitation: a QR code, and a link to send them.
3. On their phone, they install Aeneas and scan the QR code with the camera, or open the invitation. Their phone then reaches their hub through the Direct link, at home or anywhere else, with nothing else to install.

The invitation works once, for 3 days. If it runs out, press New pairing code beside their name.

Someone who already uses Tailscale can use their hub's address on your tailnet instead: share the machine with them in the Tailscale [admin console](https://login.tailscale.com/admin/machines) (Machines, the hub machine, Share), and they accept with their own Tailscale account.

The same steps from a terminal on the hub's machine:

```bash
sudo bash ~/everythingapp/deploy/people.sh add Jamie
```

On Windows, in a PowerShell window opened with Run as administrator (from another administrator's account, write your own hub folder in place of `$env:LOCALAPPDATA\AeneasHub`):

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\people.ps1" add Jamie
```

## What each person gets

- **Their own account**, named `aeneas-<name>`.
  - On Linux it has no password and no login, and its home folder is mode 700.
  - On Windows it is a local account with a long random password that nobody knows: it is never shown and no file holds it, and only Windows' Task Scheduler keeps it, to start that person's hub (Windows 11 lets an administrator register a task without a password only for their own account). It is hidden from the sign-in screen and refused sign-in at the screen, over Remote Desktop and from the network; it may only run its hub's task. Its hub lives in `%ProgramData%\Aeneas\people\aeneas-<name>`, which only that account, SYSTEM and administrators can open. Windows keeps account names to 20 characters, so the name part is at most 13.
- **Their own hub** on its own port (8788 and up), reachable through the Direct link from anywhere, and on your tailnet when Tailscale runs on the machine (for example, `https://core.example.ts.net:8788`).
- **Their own everything else**: database, notes folder, work space key, chats, linked accounts, nightly backups and devices.
- **A name and a color.** Their devices show these:
  - the web app (Windows, Android, browser) shows a dot in the hub's color and "Jamie's hub" in the sidebar and the top bar, and puts the name in the window title;
  - the iPhone, iPad and Mac app shows it under Settings, Connection.

  A hub on a machine with only one person has no color and looks as it always did.

## What they share

- **The model server.** It is shared through the **model gate** (`hub/src/gate.ts`), a small service run by the owner's account (on Windows, the task `\Aeneas\Aeneas gate`). Every hub on the machine talks to the gate instead of to Ollama directly (on Windows, every hub but the owner's: see Limits).
  - **A reply comes first.** Someone waiting on a reply goes before a capture being filed, which goes before background reading (mail, note tags).
  - **Two people asking at once take turns.** They alternate call by call, so one person's long assistant answer, with several tool steps, cannot shut the other out.
  - **A chat can stop background work.** If one person's background reading holds the model when another person starts a chat, the reading stops and is tried again later.
  - **Warm-ups give way.** A warm-up (when someone opens the assistant) only runs on an idle model that nobody else used in the last two minutes, so it never pushes someone's conversation out of the model's memory.
  - **Only the owner manages models.** Only the owner can add or remove models. Everyone else runs the owner's model, so no second large model pushes the shared one out of GPU memory.
  - **"Waiting for the shared model."** A person whose chat is waiting sees that status. They are never told whose question is ahead of theirs.
- **The owner's settings for how the model runs.** These are the model, its context size, how long it stays loaded, web search, and the time zone.
- **CPU and memory.** On Linux, systemd gives every account an equal share of the processor by default, so one person humming a long melody does not slow the other's hub. Windows shares the processor between programs, not accounts.

## What other people's hubs cannot do

- Reach the owner's machines. Their accounts have no SSH keys, and Homelab and Sensors start switched off.
- Read this machine's disks or temperatures.
- Use the image service. That is the owner's only.
- Add people. Only the owner's hub offers that.

## Looking after them

All of these run on the hub's machine, with sudo, from the owner's account:

```bash
# everyone's hubs, addresses, colors, and whether each is up
sudo bash ~/everythingapp/deploy/people.sh list

# after updating your own hub with the install command: everyone else's to the same code and model settings
# (an update from the app, Settings, About, Update hub, does this by itself)
sudo bash ~/everythingapp/deploy/people.sh update

# stop a hub and turn off its address (also in the app, the Stop button beside their name); their data stays
sudo bash ~/everythingapp/deploy/people.sh remove Jamie

# delete a stopped person's account and data for good (only from the terminal, never from the app)
sudo bash ~/everythingapp/deploy/people.sh remove-account aeneas-jamie --erase aeneas-jamie
```

`unsetup` turns all of this off again, once the other people's hubs are removed. It puts your own hub back on the model server directly.

On Windows the same commands run in a PowerShell window opened with Run as administrator, with `people.ps1` and PowerShell's way of naming options:

```powershell
$people = "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\people.ps1"
powershell -ExecutionPolicy Bypass -File $people list
powershell -ExecutionPolicy Bypass -File $people update
# stop a hub; the account is disabled and their data stays
powershell -ExecutionPolicy Bypass -File $people stop Jamie
# stop it and delete the account and data for good
powershell -ExecutionPolicy Bypass -File $people remove Jamie -Erase Jamie
powershell -ExecutionPolicy Bypass -File $people remove-account aeneas-jamie -Erase aeneas-jamie
powershell -ExecutionPolicy Bypass -File $people unsetup
```

## How the app adds someone without root

Your hub runs without any special rights and never runs anything as root. Here is what happens instead:

1. When you press Add, your hub writes a small request into `/var/lib/aeneas/requests`. Only your account can write there.
2. A system service, `aeneas-people.path`, notices the request. It runs the root-owned copy of this script, `/usr/local/sbin/aeneas-people`, that `setup` installed.
3. That copy accepts only three requests: add, a new pairing code, or stop. Each one names a person and nothing else, and every field is checked before anything runs.
4. Progress and the result (the address and a one-time pairing code) go to `/var/lib/aeneas/results`. Only your account can read that folder.
5. While a hub is being set up, the hub's code is read as you and written as the new account, so root itself never runs your code.

On Windows it works the same way, with Windows' own pieces:

1. Your hub writes the request into `%ProgramData%\Aeneas\requests`. Only your account and SYSTEM can write there.
2. The scheduled task `\Aeneas\Aeneas people` runs as SYSTEM, looks at that folder every few seconds, and runs the copy of `people.ps1` that `setup` put in `%ProgramFiles%\Aeneas`. Only administrators can change that copy, so code your own account can change never runs as SYSTEM: it follows your code only when you run `setup` or `update` yourself, elevated.
3. That copy accepts only add, a new pairing code, stop, an offer to help (ward) and update, with the same checks as on Linux. Each request runs in a PowerShell of its own, and what it is for is passed in the environment, never on a command line.
4. Progress and the result go to `%ProgramData%\Aeneas\results`, which only your account and SYSTEM can read.
5. Each person's hub runs from a scheduled task of its own, `\Aeneas\Aeneas hub (aeneas-<name>)`, as their account with no stored password, from boot, before anyone signs in.

## Limits

- **The machine's admin can read every hub** (see Who can see what).
- **One answer is written at a time.** With one place on the gate (the default), replies don't overlap. If Ollama runs with `OLLAMA_NUM_PARALLEL` above 1 and the GPU has room for it, set `EA_GATE_SLOTS` to match in `~/.config/systemd/user/aeneas-gate.service` (on Windows, in the gate's `config\services.json` inside your hub folder, or set it before `setup`).
- **On Windows the gate cannot tell the hubs apart.** On Linux it reads which account a connection comes from out of the operating system; Windows does not give it that. So on Windows the other people's hubs take turns in the order they ask, and your own hub keeps talking to the model server directly, which also lets it add and remove models.
- **Linux with Tailscale, or Windows.** A hub on a Mac has one person.
