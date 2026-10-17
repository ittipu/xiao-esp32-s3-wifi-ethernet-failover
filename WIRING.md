# Wiring — XIAO ESP32-S3 PoE failover node

## Pin map

| XIAO pin | GPIO | Used for | Connect to |
|---|---|---|---|
| **D0** | GPIO1 | DHT22 data | DHT22 **DATA** |
| D1 | GPIO2 | W5500 CS | *on-board, do not use* |
| D2 | GPIO3 | free | — |
| D3 | GPIO4 | free | — |
| **D4** | GPIO5 | I²C SDA | TSL2561 **SDA** (and OLED SDA, optional) |
| **D5** | GPIO6 | I²C SCL | TSL2561 **SCL** (and OLED SCL, optional) |
| D6 | GPIO43 | UART TX | free |
| D7 | GPIO44 | UART RX | free |
| D8 | GPIO7 | W5500 SCK | *on-board, do not use* |
| D9 | GPIO8 | W5500 MISO | *on-board, do not use* |
| D10 | GPIO9 | W5500 MOSI | *on-board, do not use* |
| **3V3** | — | sensor power | DHT22 **VCC**, TSL2561 **VIN** |
| **GND** | — | ground | DHT22 **GND**, TSL2561 **GND** |

D1, D8, D9 and D10 are wired to the W5500 Ethernet chip on the board. Never
connect anything else to them.

> Check your board's header silkscreen before wiring: confirm D0, D4 and D5 are
> broken out on the XIAO ESP32-S3 PoE board's headers.

## Sensors

### DHT22 (temperature + humidity)

| DHT22 | XIAO |
|---|---|
| VCC (+) | 3V3 |
| DATA (out) | **D0** |
| GND (−) | GND |

- 3-pin modules already have a pull-up resistor.
- A bare 4-pin DHT22 needs a **10 kΩ resistor between DATA and 3V3**; leave pin 3 unconnected.

### TSL2561 (light, lux)

| TSL2561 | XIAO |
|---|---|
| VIN | 3V3 |
| GND | GND |
| SDA | **D4** |
| SCL | **D5** |
| ADDR | leave unconnected → I²C address **0x39** |
| INT | leave unconnected |

### OLED (128×64, I²C 0x3C)

Same bus as the TSL2561: VCC → 3V3, GND → GND, SDA → **D4**, SCL → **D5**.
Set `USE_OLED 1` in the sketch, then pick the controller:

- **1.3" module** → usually **SH1106** → `OLED_SH1106 1` (default)
- **0.96" module** → usually **SSD1306** → `OLED_SH1106 0`

If the left edge is cut off and there's a garbage line down the right side,
switch to the other controller.

## Diagram

```
                 XIAO ESP32-S3 PoE
              ┌─────────────────────┐
  DHT22 DATA ─┤ D0               5V ├─
   (on-board) ┤ D1 W5500 CS     GND ├─── GND  (DHT22, TSL2561)
              ┤ D2              3V3 ├─── 3V3  (DHT22 VCC, TSL2561 VIN)
              ┤ D3        D10 MOSI  ├ (on-board W5500)
 TSL2561 SDA ─┤ D4 SDA     D9 MISO  ├ (on-board W5500)
 TSL2561 SCL ─┤ D5 SCL     D8 SCK   ├ (on-board W5500)
              ┤ D6 TX      D7 RX    ├
              └──────────┬──────────┘
                     RJ45 / PoE  ── one cable: power + Ethernet
```

## Power

- **PoE:** plug into an IEEE 802.3af PoE switch or injector. One cable powers the
  board and carries Ethernet.
- **USB-C:** also works (for flashing, or WiFi-only testing).
- Both sensors run from the board's **3V3** pin. Don't power them from 5V: the
  XIAO's GPIOs are 3.3 V only.
