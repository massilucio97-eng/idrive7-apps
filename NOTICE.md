# Notice

This repository builds on, and keeps the licences of:

- **arefahmad/idrive7-apps** (MIT, `LICENSE.arefahmad`): Car Lyrics' track reader, network client and clock.
- **nickgcode/idrive7-apps** (MIT, `kit/LICENSE.nickgcode`, `apps/amn_hudlyrics/LICENSE`): the MGU App Kit as
  used here, the LRCLIB lyrics client, and the HUD layer (`apps/amn_hudlyrics/hud/`, from G's Music 0.8.0), changed
  for a one-line mode and the HUD's measured visible window.
- **cauliflowermossgrape/idrive7-apps** (MIT, `kit/LICENSE.idrive7-apps`): the MGU App Kit. Also Redline's HUD drawing (`apps/amn_hudlyrics/hud/redline/`, from Redline 2.0.42, HUD by @biscotit), unchanged, for HUD Lyrics' Sport HUD, with its gearbox.js; `kit/runtime/hud_claim.js`, `readonly-diag.js` and `dids.js`.
- **robertnisipeanu** (mgu-store, cluster-render): the Store and the cluster/HUD renderer, used as installed.

- **Inter** (SIL Open Font License 1.1, `apps/amn_hudlyrics/data/fonts/LICENSE-Inter.txt`): the centre screen's type.

Changes to the kit: the encrypted crash-log uploader (`remotelog.js`, `ringlog.js`, `x25519.js`) is removed,
and `kit/runtime/mgu.js` no longer loads it. The unused `gif_drop.js` (phone-to-car GIFs through ntfy.sh) is removed.

IPTV (`apps/amn_iptv`, `native/amn-iptv`, `native/tvh-player`):

- **aurelmarius/bmw-apps** (commit 921832956f301c0b889c0643a768f05c2b0216df): the TVH Player service and its player
  tvh-player, **GPL-3.0-or-later** (`native/amn-iptv/LICENSE`, `native/tvh-player/LICENSE`). The service is changed for
  Xtream Codes; the player binary is unchanged, its source in `native/tvh-player`. FFmpeg: LGPL-2.1-or-later
  (`native/amn-iptv/FFMPEG-LICENSE`). Its decoder builds on Robert Nisipeanu's waze-on-cluster via Moonride (GPL-3.0-or-later).
  **Changed by massilucio97-eng (Nov 2026)**: `tvh-player` (`src/player.cpp`, `src/decoder_msdk.cpp`) for the Stretch
  picture mode (`MGU_STRETCH`: the picture made the shape it is shown in, not cropped); the service (`service.js`)
  passes it and adds the phone remote's support. The changed source is in this repository; the binary is built from it
  by this fork's GitHub Actions.
- **leschi/mgu-media-client** (MIT): park check, on-screen keyboard, PNG decoder (changed to keep transparency).
- jpeg-js (BSD-3-Clause), pdf.js decoder core (Apache-2.0), Project Nayuki QR code generator (MIT), Inter (OFL):
  `apps/amn_iptv/LICENSE.third-party`.

No BMW code or SDK is in this repository. `oap-sdk/` and `dist/` are never committed.

## App icons (Nov 2026)

The icons of HUD, IPTV and Side View are drawn by `docs/make_icons.py` (our own marks, BMW-menu style with the M
colours), no third-party artwork.

## This fork (massilucio97-eng)

- **Carburante** (`apps/mas_carburante`, MIT): new. Uses the MGU App Kit (above) and IPTV's full-screen layer
  (`fuel/fullview.js`, from `apps/amn_iptv/lib/fullview.js`). Data: MIMIT Osservaprezzi carburanti (IODL 2.0),
  Open-Meteo (CC BY 4.0). Messages to the phone through ntfy.sh.
- **IPTV** changes: Stretch, phone remote (`lib/remote.js`), next episode, favourites sync, logs to the phone.
- **extras/**: `carburante_widget.js`, `iptv_telecomando.js` (Scriptable scripts, MIT).
