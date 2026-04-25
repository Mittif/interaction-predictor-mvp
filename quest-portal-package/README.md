# Quest Portal Hub

This folder packages the `localhost:8000` interaction-predictor output into a Quest 3 portal launcher.

## What It Does

- Reads `/Users/mitty/Documents/GitHub/interaction-predictor-mvp/data/first_person_analyses.jsonl`.
- Watches the latest JSONL record.
- Scores the record against configurable scene rules in `config/portal.config.json`.
- Shows a WebXR room-scale Home stage with all configured portals open; the JSONL winner is highlighted as the recommended route.
- Serves the Home stage, local vendor files, local media, local scene pages, and the packaged Gemini Slingshot game from this folder.
- Lets Quest controllers enter any of the three current scenes:
  - Cinema: local stereo-video-style scene at `/scenes/cinema.html`
  - Family KTV Audio: local positional-audio-style KTV scene at `/scenes/garage-ktv.html`
  - Gemini Slingshot: packaged local game at `/game/`

## Start

```bash
cd /Users/mitty/Documents/GitHub/interaction-predictor-mvp/quest-portal-package
./start.sh
```

Open the Quest 3 Browser to the printed HTTP LAN URL first, for example:

```text
http://<your-mac-lan-ip>:8787/
```

If the Quest Browser does not expose `Enter VR` on HTTP, use the printed HTTPS LAN URL:

```text
https://<your-mac-lan-ip>:9443/
```

Quest WebXR may require a secure context on LAN. `start.sh` creates a local self-signed certificate in `certs/`; accept the browser warning once on the headset.

## Stop / Restart

```bash
cd /Users/mitty/Documents/GitHub/interaction-predictor-mvp/quest-portal-package
./stop.sh
./start.sh
```

Static scene edits can usually be tested with a browser refresh. Changes to `server.mjs`, `start.sh`, ports, certificates, or media streaming behavior require restarting `./start.sh`.

## Assets

Runtime assets currently served from this folder:

- Three.js and WebXR support: `public/vendor/`
- Cinema video: `public/media/ascii-hello-world.mp4`
- KTV music loop: `public/media/garage-ktv-loop.wav`
- Local Cinema and KTV scene code: `public/scenes/`
- Gemini Slingshot build: `public/game/`

The Cinema and Family KTV Audio scenes are local integrations modeled after the Immersive Web stereo-video and positional-audio samples. Keeping them local avoids exiting the portal chain and lets `start.sh` preload all media/assets from this folder.

## Configuration

Edit `config/portal.config.json` to add scenes or tune routing.

Each scene has:

- `id`, `title`, `label`
- `kind`: `local` or `external`
- `url`: scene URL
- `portal`: color and home-stage position
- `rules`: weighted keyword lists matched against the latest JSONL record

The current fallback scene is `cinema`.

## Files

- `server.mjs`: local server, JSONL watcher, static file server, routing API.
- `public/index.html`: Quest home stage entry.
- `public/js/home-stage.js`: Three.js WebXR portal scene.
- `public/scenes/`: optional local fallback scenes.
- `public/game/`: copied Gemini Slingshot build.
- `public/media/`: local cinema video and KTV audio.
- `public/vendor/`: local Three.js and WebXR support files.
