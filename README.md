# HamClock Web

A free, **browser-only** ham-shack clock and propagation dashboard. No install,
no server, no account — open the page, enter your callsign and grid square, done.

**Live:** https://w4ewbradio-sudo.github.io/hamclock/

## Inspired by HamClock — a tribute

This project is inspired by **[HamClock](https://hamclock.com) by Elwood Downey,
WB0OEW (SK)** — the beloved shack display he built and gave to the amateur radio
community for free. Elwood became a Silent Key in January 2026, and the original
HamClock's data backend was retired in June 2026. Community efforts like
[hamclock.com](https://hamclock.com) ("Keeping HamClock Alive") and
[OpenHamClock](https://github.com/accius/openhamclock) are carrying his idea
forward — this page is another take on that legacy: where the original is a
native app and OpenHamClock runs on a Node.js server, HamClock Web is a plain
static page whose data comes straight from public feeds in your browser, so it
needs nothing but a URL.

It is an **independent, from-scratch implementation** — no HamClock code is used —
and it is not affiliated with Clear Sky Institute, hamclock.com, or OpenHamClock.
73 and thank you, Elwood. **·— ·— ·—**

## Features
- World map (flat or real 3D WebGL globe) with live NASA satellite / Blue Marble basemaps
- DX cluster spots with great-circle paths colored by band (SpotHole)
- Space weather: SSN, solar flux, Kp, GOES X-ray, DRAP absorption, aurora (NOAA SWPC)
- MUF / foF2 contours (KC2G), grayline, NCDXF beacons, satellites, moon
- PSK Reporter: who hears you (or what you hear), plus your latest spotted mode
- Local weather at your QTH (open-meteo), band conditions (hamqsl)
- Everything configurable from the ⚙ settings panel; preferences stay in your browser

## Privacy
100% static. Your callsign/grid live in your browser's localStorage and are only
sent to the data services the page queries on your behalf (PSKReporter, open-meteo).

## Data credits
SpotHole · NOAA SWPC · KC2G (prop.kc2g.com) · PSKReporter.info · CelesTrak ·
open-meteo · hamqsl.com (N0NBH) · NASA SDO / GIBS / Blue & Black Marble · Natural Earth

Built by W4EWB. This repo is a generated bundle; the source lives in the
W4EWB Control Center project.
