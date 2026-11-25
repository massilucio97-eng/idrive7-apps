# Mappa larga

The phone's map from **Maps on cluster** (robertnisipeanu/idrive-apps) shown larger on the instrument cluster: one
rect between the two gauge arcs, over BMW's digital speed and consumption readouts, with Waze's arrival line
(arrival time, minutes, km) under it. iDrive 7 · package `mas_mappa_larga` · needs Maps on cluster and its Cluster
renderer, with "host from layers" (cluster-render PROTOCOL.md).

- **Off by default.** Settings > *Mappa larga sul quadro*.
- **Set it up parked**, in P: *Griglia di prova* draws a grid over the whole cluster (every 40 px, numbers every
  200) with the rect in green; move its four edges (*Bordo sinistro / destro / alto / basso*) until it sits inside
  the arcs without touching them, then turn the grid off. The grid is never shown while the car moves.
- **Never over** the arcs, the bottom bar or the warning lamps, as long as the rect is set inside them. With no
  phone map, the setting off or a warning on the cluster, nothing of this app shows: the cluster is BMW's own.
- **Arrival line:** the km left come from BMW's GuidanceEventList (the phone's route events, read as
  cauliflowermossgrape's Redline does). The time to the destination is not proven yet: *Diagnostica percorso*
  lists the car catalog's entries that could carry it, for the next version.
- Images only, no shaders (a heavy shader once restarted a cluster: Redline README).
