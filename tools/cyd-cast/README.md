# PlaneCast CYD

Firmware for an ESP32 "Cheap Yellow Display" (ESP32-2432S028R, 2.8" ILI9341) that keeps the plane map cast on the Nest Hub, with no phone needed.

- Holds a Cast connection to the Hub (TLS port 8009, the protocol catt uses) and watches its status.
- When the Hub returns to its idle screen for 5 s, it launches DashCast (`84912283`) and loads the map with `force: true`, like `catt cast_site`.
- Leaves the Hub alone while another app is cast. Screen buttons: **Cast now** (takes over) and **Pause / Resume**.
- First boot opens a `PlaneCast-Setup` hotspot (WiFiManager) for Wi-Fi, map address and Hub IP. Blank Hub IP = find it by mDNS, preferring a device whose model contains "Hub". Hold BOOT 3 s to reopen setup.

## Install

Easiest: open https://planes-steel.vercel.app/cyd/ in Chrome on a computer and press Install. The image there (`cyd/planecast-cyd.bin`) is built and committed by `.github/workflows/cyd-firmware.yml` on every push to main that touches this folder.

From source: `pio run -d tools/cyd-cast -t upload`, then `pio device monitor` for the log.

Boards with two USB ports (USB-C + micro-USB) have an inverted panel: use env `cyd2usb` (adds `-DTFT_INVERSION_ON`). If yours shows an ST7789 instead, swap `-DILI9341_2_DRIVER=1` for `-DST7789_DRIVER=1`.
