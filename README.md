# idrive7-apps · fork by massilucio97-eng

Apps for BMW head units with **iDrive 7** (MGU), installed from the car through
[robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store).

This is a **fork of [M850i-amn/idrive7-apps](https://github.com/M850i-amn/idrive7-apps)**. The original apps,
the MGU App Kit and the IPTV service are the work of their authors (below and in [NOTICE.md](NOTICE.md)); this fork
adds a new app, **Carburante**, many improvements to **IPTV** and two companion scripts for the iPhone. Everything is
tested on a BMW 118i (F40), iDrive 7 MGU, software P18_23w44.

## What comes from other projects

| From | What is used here | Licence |
|---|---|---|
| [M850i-amn/idrive7-apps](https://github.com/M850i-amn/idrive7-apps) | The base of this repository: HUD, Side View, the IPTV app and its service as they were, the build tools | MIT |
| [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) | The MGU App Kit (`kit/`): app runtime, canvas, renderer and cluster clients, uplink, settings | MIT |
| [nickgcode/idrive7-apps](https://github.com/nickgcode/idrive7-apps) | Parts of the kit, the lyrics client and the HUD layer (HUD) | MIT |
| [arefahmad/idrive7-apps](https://github.com/arefahmad/idrive7-apps) | Car Lyrics' track reader, network client and clock (HUD) | MIT |
| [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) | The TVH Player service and the video player `tvh-player` (IPTV) | GPL-3.0-or-later |
| [leschi/mgu-media-client](https://github.com/leschi/mgu-media-client) | Park check, on-screen keyboard, PNG decoder (IPTV) | MIT |
| [robertnisipeanu](https://github.com/robertnisipeanu) | The MGU Store, the uplink and the cluster renderer (used as installed); waze-on-cluster, on which the player's decoder builds | MIT / GPL-3.0-or-later |
| Data and services | Fuel prices: MIMIT, Osservaprezzi carburanti (IODL 2.0) · weather: [Open-Meteo](https://open-meteo.com) (CC BY 4.0) · car ↔ phone messages: [ntfy.sh](https://ntfy.sh) · phone scripts run in [Scriptable](https://scriptable.app) | |

## What this fork adds

### New app: Carburante (`apps/mas_carburante`)
- **Prices around you** from the MIMIT open data: petrol, diesel, LPG, methane; self, served or the cheapest;
  by town or by the iPhone's position; radius; sorted by price or distance.
- **Refuel diary**: refuels detected from the tank level, the station picked with a tap, **real consumption in km/l**,
  cost of every trip, the month's costs.
- **Price trend**: are the stations around raising or lowering their prices? *Fill up today* or *wait 1-2 days*,
  from the app's own daily price history.
- **Phone notifications** (ntfy): low range with the cheapest station, refuel, trip ended, prices rising.
- **iPhone GPS bridge**: an iOS Shortcut sends the phone's position (and street) when CarPlay connects and
  disconnects; without a phone the app works by town as before.
- **Welcome screen**: when you get in, four large cards over the whole centre screen (weather, range in km/l,
  prices, last trip), your name, and an orange ambient-light flash when there is something to know.
- **Monthly report** to the phone, as a page (print to PDF) and a CSV: totals, refuels, and the trips **grouped
  by street of departure and arrival** (nearby house numbers count as one place).
- **Portami lì**: a tap on a station sends the phone a notification that opens Waze (or Apple Maps) there.
- **Send the log to the phone** when something does not work.
- **Real cost of a full tank**: stations sorted by price plus the road to get there.
- **Modalità officina** (workshop mode): before leaving the car to a mechanic or a valet, our apps hide your data
  behind a 4-digit PIN (IPTV shows only a keypad), the trip is recorded (km, top speed, minutes over a chosen speed,
  fuel used) and sent to the phone. It turns itself off when your iPhone reconnects, or with the PIN, or from the phone
  (Siri). It does not touch BMW's own menus (use the Guest profile) and it is not an anti-theft.

### IPTV improvements (`apps/amn_iptv`, `native/amn-iptv`, `native/tvh-player`)
- **Stretch** picture mode: full screen, stretched instead of cropped or letterboxed (change in `tvh-player`,
  rebuilt by this fork's GitHub Actions).
- **Phone remote**: browse the whole playlist on the iPhone (live TV with what is on, films with plot and poster,
  series by season and episode, search, favourites) and play it on the car's screen; pause, ±30 s, stop, next or
  previous channel. A new page *Telefono* with a QR code links the phone.
- **Next episode automatically** after 10 s, cancellable on the screen and on the phone.
- **Favourite channels synced** between the car and the phone.
- **Send the log to the phone** (app and service), shown as a QR code.
- **Modalità officina**: while Carburante's workshop mode is on, playback stops, the phone remote is ignored and only a PIN keypad shows.

### iPhone scripts (`extras/`)
- `carburante_widget.js`: Home-screen widget (Scriptable) with range, km/l, the cheapest station and the price
  around over 14 days as a chart.
- `iptv_telecomando.js`: the IPTV phone remote (Scriptable).

## Apps

| App | What it does |
|---|---|
| [IPTV](apps/amn_iptv/README.md) | Your own Xtream Codes IPTV account's live channels on the centre screen, UHF-style: favourites, TV guide, categories, search, full-screen player. Needs the **IPTV service** (same source). Your login stays on your car. |
| [HUD](apps/amn_hudlyrics/README.md) | Synced lyrics for the song playing over CarPlay, one line at a time in the head-up display (experimental, off until switched on), and a Now Playing page on the centre screen. In Sport a rev tach replaces the lyrics (Redline's Ramp layout, after the G80 M3 / M4), back to the lyrics in Comfort, Eco Pro and Adaptive. |
| [Side View](apps/amn_sideview/README.md) | The camera on the side you signal, on the instrument cluster: left signal, the left camera; right signal, the right camera; hazards, nothing. Turn signals read from the car's light module. Needs the 360 cameras (Surround View) and the **Cluster renderer** and **Side View camera** tools (the camera tool is Robert Nisipeanu's waze-on-cluster, GPL, with Side View's settings). |
| [Carburante](apps/mas_carburante/README.md) | **New in this fork.** Fuel prices around you, refuel diary with real km/l, trip costs, price trend, welcome screen, monthly report and phone notifications. |

## Install

1. In the Store: **Settings > Add source**, type `massilucio97-eng/idrive7-apps`, pick **Branch main**.
2. Pick an app (IPTV, Carburante, HUD, Side View) and tap **Install**. The head unit builds it from this repository.
3. Restart the head unit once if the Store asks (Store **Settings > Restart head unit**).

Needs root access, mgu-store, internet through the Store's uplink (IPTV, Carburante, HUD's lyrics), and the Store's
**Cluster renderer** tool for the HUD and Side View.

## Safety

HUD: 
Read-only toward the car: it subscribes to and reads signals, and never writes, codes, clears or controls
anything. One internet host: `lrclib.net`. No accounts, analytics or crash-report uploads.

IPTV: talks only to the IPTV provider you sign in to, through the IPTV service. The service runs as root (it plays video and opens
the sign-in page on the car Wi-Fi for 10 minutes); its internet goes through mgu-uplink as its own uid. The app calls the
audio manager to put the TV sound on the speakers, and nothing else in the car.

Carburante: read-only toward the car (fuel level, odometer, range, speed, doors, the car's state). Internet hosts:
`www.mimit.gov.it` (prices), `ntfy.sh` (the phone, through a private random channel made on the car),
`api.open-meteo.com` (weather). It writes nothing to the car; the welcome's flash goes through Ambient config's flash
file.

IPTV phone remote: the phone talks to the Xtream server itself; the car only receives "play this" through a private
random ntfy.sh channel made on the car. The Xtream login never goes through it.

## Credits

See [NOTICE.md](NOTICE.md) for every project, licence and change. Unofficial. Not made, endorsed or supported by
BMW. Use at your own risk.

## Support this fork ☕

The apps are free and open source. If **Carburante** or the **IPTV improvements** make your drives better, you can
buy me a coffee: it helps me keep them working after iDrive updates and build new ones. To thank the original
authors, see their repositories above.

[![PayPal](https://img.shields.io/badge/PayPal-Offrimi%20un%20caff%C3%A8-003087?logo=paypal&logoColor=white)](https://paypal.me/massilucio)

🇮🇹 Le app sono gratuite e lo resteranno. Se le mie aggiunte ti sono utili, puoi offrirmi un caffè: mi aiuta a
mantenerle aggiornate e a crearne di nuove.

Donations are voluntary and do not buy support, warranties or features.
