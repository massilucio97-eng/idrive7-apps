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
