# Using Aeneas

How to do the common things, and where each one lives. The assistant reads this page (and the other docs and the
module list) to answer questions about the app, so ask it too: "how do I get my calendar in?"

## The parts

- **The hub** is the computer at home that keeps everything and runs the models. Every app is a window onto it.
- **The apps**: iPhone, iPad and Mac (one Apple app), Apple Watch (through the iPhone app), Windows, Android, and the
  web app in a browser. They show the same data; what differs is what each device can read from itself (only the
  Apple apps can read Apple Calendar, Reminders, Contacts and Health).
- **Modules**: everything outside the core (Today, Assistant, Capture, Search, Unsorted Info, Tasks, Week, Notes,
  Memory, People, Lists) is a module you switch on or off in Settings, Modules. The setting is the same on every device.

## Add another device (pair a new phone, tablet or computer)

On a device that is already paired, open Settings, Connection, Pair another device. It shows a code (and a QR code)
that works once, for 10 minutes. On the new device, install Aeneas, open it and scan the QR code or type the code
and the hub's address. Reinstalling the app on a device means pairing it again the same way.

## Calendars

There are two directions, and they are set up in different places.

### Your iCloud calendars, on the hub (every device)

The Calendar accounts module keeps your iCloud calendars in step with Aeneas on the hub, both ways, so every device
has them: Windows, Android and the web as well as the Apple apps. Switch it on in Settings, Modules, then open
Settings, Connections, iCloud Calendar:

1. Make an app-specific password at account.apple.com (Sign-In and Security, App-Specific Passwords). An address
   already linked for iCloud Mail needs no new one: it is the same password.
2. Enter the address and the password, and choose Link. The hub checks them with iCloud and lists your calendars.
3. Tick the calendars to keep in step, and pick where events made in Aeneas go.

Single events in those calendars, from 30 days back to a year ahead, come in as your events; edits and deletions
made either in Aeneas or in iCloud reach the other side within about 5 minutes (10 seconds after a change in the
app). When both sides changed the same event, the newer change wins. Repeating events come in as their occurrences,
7 days back to 90 days ahead, and are changed in iCloud. Only the title, times and place are synced; notes, alerts and
invitees stay as they are in iCloud. Work events never leave the hub. A read-only calendar (a subscribed holiday
calendar) only comes in. Sync now syncs at once; Stop syncing keeps the events in Aeneas and deletes the password
from the hub unless iCloud Mail still uses it.

While the hub keeps a calendar in step, the iPhone, iPad and Mac leave personal events to it, so nothing is copied
twice. Google and Exchange calendars are not synced by the hub yet: for those, use the Apple apps below.

### Calendars through the Apple apps

The Apple apps can also read Apple Calendar on the device (so any account Apple Calendar has: iCloud, Google,
Exchange and others). Switch on the Apple Calendar module in Settings, Modules, then on the iPhone, iPad or Mac open
Settings, Calendar and work:

- **Where app events go**: the calendars that events made in Aeneas (by you or the assistant) are copied into.
  Changes made to them in Apple Calendar come back; single events made in those calendars come in both ways, and
  repeating ones come in as read-only occurrences. While the hub syncs iCloud calendars, this part is off.
- **Work meetings to import**: calendars you mark as work. Only the title and time of each meeting are read, from
  7 days back to 30 days ahead. They show as Work in Today and Week and count as busy time. This is the way in for an
  employer's Exchange calendar, which often does not allow other apps to sign in.

The Mac app copies at once; the iPhone after about two minutes.

### Your plan out to any calendar app

Settings, Connections, Calendar has **Subscribe in calendar app** and **Copy link**. This goes the other way: it
publishes your scheduled tasks, events, reminders and renewal dates as a calendar feed that Apple Calendar, Google
Calendar or Outlook keeps up to date by itself. It does not bring any calendar into Aeneas. Work items stay out. The
link's key reads only this feed; New link ends the old one. On a computer, Subscribe asks which calendar app to open;
Copy link and adding it as a subscribed calendar by URL works in any calendar app.

## Mail

Mail is read on the hub, not on the devices: Settings, Connections, Gmail or iCloud Mail, with the Mail receipts
module on. The hub reads only mail that looks like receipts, renewal notices or vet mail, files them as renewals and
pet visits, and does not keep the mail itself. It does not show mail in Week or anywhere else.

- **iCloud Mail** needs an app-specific password you make at account.apple.com; the guide in Settings, Connections
  takes you through it. The password is kept only on the hub. Apple's app-specific passwords also open iCloud
  Contacts and Calendars; Aeneas uses it for mail, and for calendars only when Calendar accounts is on.
- **Gmail** needs your own Google app, allowed only to read mail, and the hub reached through Tailscale (Google
  returns only to an https name). The steps are in [gmail-setup.md](gmail-setup.md) and in the guide in Settings,
  Connections.

## Reminders, Contacts and Health

These are read on the Apple devices: the Apple Reminders and Contacts modules (Settings, Modules), and Apple Health,
turned on in the iPhone app under Settings, Connections. Health works both ways: readings come in, and what you log
in Aeneas goes to Health.

## Capture

Capture takes a thought, task or note by voice or text, from the Capture screen, the Watch, or the Mac menu bar.
Each capture goes into the day's diary and the assistant files it where it belongs (a plan on the calendar, a to-do,
a fact in memory, a tagged note, a song idea, a film to watch), or nowhere when it is only a passing thought (the
diary has it). One it could not file after three tries waits in Unsorted Info.

## Hum Song

Music module. Press Hum Song (in Capture, Music, or on the Watch) and hum, sing, tap or beatbox for up to 2 minutes.
The hub hears every recording both as a melody and as a rhythm. Afterwards, on the idea in Music, choose Melody,
Rhythm or Both; playback and the MIDI download follow that choice.

## Apple Watch

The Watch reaches the hub through the Aeneas app on the paired iPhone (over Bluetooth or Wi-Fi), not on its own.
Its first page has Ask, Capture and Hum Song, all by voice. Capture records what you say on the Watch (up to 5
minutes; press Done when you finish) and the iPhone turns it into text on the phone itself, so a long thought is kept
whole and the recording never goes to Apple. Ask uses Apple's dictation, which shows the words as you speak and suits a
short question (it keeps only about the last 30 seconds of a long one). Complications (add them by editing a watch face):
Ask, Capture, Hum Song, Now and Next up. When the Watch shows Offline, tap Offline, then Try now; opening the iPhone
app helps it reconnect.

## The assistant

The assistant runs on your hub's own model. It reads and changes your data with tools (adding tasks, reminders,
notes, events), and it says what it changed. Switch modules off and their tools go with them. Ask it about the app
itself too: it answers from these docs.

## Family: a hub for someone else, and helping with their devices

On a Linux or Windows hub, Settings, People on this machine gives someone their own hub on your machine. Invite them
with the large QR code when they are with you, or copy a message (or print a page) for someone who lives elsewhere: they
install Aeneas, copy the message and tap I have an invitation. Help with devices beside their name asks them once,
in large type; after their yes, your assistant can check and fix their computer (the Aeneas app on it), the devices
their app found at home, and devices that take SSH, with the passwords they chose to save for you. They see everything
you did in Settings, People who help you, and can stop it there. The whole story: [helpers.md](helpers.md).

## Updates, backups and the hub

- **Updates**: Settings, About shows the hub's version and updates it. The Windows and Android apps update from
  the hub: when the hub runs a newer release, a banner and Settings, About have **Update app**, which installs the new
  app from the hub (Windows closes and opens the new app by itself; Android shows its own install prompt, and the first
  time asks whether Aeneas may install apps). Apps older than 1.0.5 have no Update app: install the new one once from
  the release page, and it updates itself after that. Apple apps update from the App Store or TestFlight.
- **Updating another device's app**: Settings, Connection, Devices shows which app and version each device runs, with
  Update for a Windows or Android app that is behind; or ask the assistant ("update my Windows app"). That app installs
  the update the next time it reaches the hub, after 15 seconds with Not now (Android waits until the app is open and
  shows its prompt there). The hub cannot install the Apple apps.
- **Backups, restore, moving to a new machine, other people on the same computer**: see
  [running-your-hub.md](running-your-hub.md) and [multi-person.md](multi-person.md).
- **How devices reach the hub** (Direct link, Tailscale or home Wi-Fi only): [connections.md](connections.md).
- **What goes where on the network**: [privacy-network.md](privacy-network.md).
