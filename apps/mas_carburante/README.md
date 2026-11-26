# Carburante

The cheapest fuel stations around a chosen comune on the centre screen, from the official **MIMIT open data**
(Osservaprezzi carburanti, licence IODL 2.0): the prices in force at 8 in the morning, published every day.
iDrive 7 · package `mas_carburante` · needs internet from the Store (mgu-uplink).

- The ten cheapest stations: price, distance, brand; address, name and the day the price was reported.
- Settings: fuel (benzina, gasolio, GPL, metano), self / servito / either, zone (a comune), radius (3-20 km).
- The distance is from the centre of the chosen comune (the mean of its stations' coordinates): the car's own
  GPS position is not read yet.
- Only `www.mimit.gov.it` is asked. The two files are read line by line and only the stations within 25 km of
  the zone (and their prices) are kept, in the app's data folder (`zone.json`). Read only: nothing is written
  to the car.
- **Trips** (0.3.0): a trip ends at a pause of 10 minutes (the car switched off); its km, fuel (from the real
  consumption, else the tank gauge) and cost (at the last refuel's price) show on the main page for 6 hours and
  on the diary page, with the month's trips, km and spend.
- **Position from the iPhone** (0.4.0): an iOS Shortcuts automation ("when CarPlay connects": current location,
  then POST "lat;lon" to `https://ntfy.sh/<topic>`) gives the stations around you; the car reads that private topic
  (`phone.js`; the head unit's firewall drops incoming connections, so the phone cannot reach the car directly).
  The topic is random, made on the car and shown on the *Collega iPhone* page, never in this repository. Without a
  position of the last 60 minutes, the zone in the settings is used, as before.

## Prezzi in salita o in calo (0.6.0)

Every day's prices of the stations around are kept 15 days (`storico.json`). The line under the status compares
them with the day before: when a fifth of the stations raised their price (twice as many as lowered it) the others
usually follow within 1-3 days, so *fill up today*; when as many lowered it, *wait 1-2 days if the range allows*;
otherwise the week's median drift, or *stable*. The first advice comes the day after the first download. With the
range under twice the range notice and prices rising: one notification a day (setting *Avvisami se i prezzi salgono*).
It is an estimate from the stations' own moves, not a forecast.

## Benvenuto (0.7.0)

When you get in (the head unit starting, the car woken up, the driver's door opened; at most once every 15 minutes,
never while driving) four large cards cover the centre screen for 8 s: the weather (Open-Meteo, CC BY 4.0), the
range with the real km/l, the prices around (rising, falling, or the cheapest), the last trip. A tap or the
controller closes it. With prices rising or the range under the notice's threshold, Ambient config (if installed, its
"Redline shift flash" setting on) flashes the lights orange twice. Settings: *Benvenuto sullo schermo*, *Luci
ambiente arancioni*. The screen is a layer of its own over the whole output (fuel/fullview.js, from IPTV).

## Riepilogo spese del mese (0.8.0)

The trips grouped by street of departure and street of arrival, the refuels and the totals (fuel, km, cost per km,
real km/l), as a page (Condividi → Stampa → PDF on the phone) and a CSV (";", Italian decimals), sent as ntfy
attachments on `<topic>-avvisi`: at the first start of a month for the month before (setting *Riepilogo spese*), or
with *Invia il riepilogo di questo mese* on the diary page. ntfy.sh keeps an attachment 3 hours.

The streets come from the phone: the Shortcut "CarPlay si connette" sends `lat;lon;via;città` (departure), a second
one "CarPlay si disconnette" sends `fine;lat;lon;via;città` (arrival). The car reads the channel's last 12 hours; a
trip without its arrival takes the next trip's departure. Places on the same street within a distance (setting, default 300 m) are one place, the house numbers shown as a
range ("Corso Francia 120-145, Collegno"); far apart on a long street, two places. Addresses are kept only in the car's diary and in the
attachments (whoever has the channel or the attachment's link can read them).

## Portami lì (0.9.0)

A tap on a station (when no refuel is waiting for its station) sends a notification to the phone (`<topic>-avvisi`):
a tap on it opens Waze navigating there (buttons: Waze, Apple Maps), and CarPlay shows the route.

## Log al telefono (0.9.2)

On "Collega iPhone", *Invia i log dell'app al telefono* sends the app's last 600 log lines as a text file to the
ntfy app (channel `-avvisi`), to forward when something does not work.

## Costo reale del pieno (0.10.0)

Stations are sorted by what a full tank really costs: the price times the litres to fill (the tank, setting *Capacità
del serbatoio*, minus what is in it, from the car) plus the road there and back (straight line x 1.35, at the real
consumption, else 6.5 l/100 km). Each row shows the full tank, the road's share and how much more than the first; the
first is marked ★ Conviene. Setting *Ordina i distributori per*: real cost (default) or price per litre only.
