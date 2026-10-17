"""Fake failover node for testing the dashboard without hardware.

Publishes DHT22/TSL2561-style readings plus node info to the broker every 2 s,
with Ethernet as the main link (firmware PREFER_ETHERNET 1), and walks through
the on-camera story:
    WiFi only -> cable plugged in (moves to Ethernet) -> WiFi killed (no change)
    -> WiFi back -> cable pulled (fails over to WiFi) -> cable back (Ethernet)
Same payload as the real firmware.

    python simulate.py              # one full demo cycle (~80 s)
    python simulate.py --loop       # repeat forever (Ctrl+C to stop)
    python simulate.py --force      # run even if a real node is publishing

It listens first and refuses to run if a real node is already publishing on
the topic: two publishers interleave and the dashboard sees fake link flips.
"""

import json
import math
import os
import random
import sys
import time

import paho.mqtt.client as mqtt

HOST = os.getenv("MQTT_HOST", "mqtt.iotbhai.io")
PORT = int(os.getenv("MQTT_PORT", "1883"))
TOPIC = os.getenv("TOPIC_NODE", "iotbhai/node")
FW = "1.3.0"
PREF = "ETH"                                   # Ethernet is the main link
IP = {"WiFi": "192.168.0.57", "ETH": "192.168.0.58"}

# (seconds, link, wifi_up, eth_up, rssi start, rssi end, what is happening)
SCRIPT = [
    (12, "WiFi", 1, 0, -55, -57, "cable unplugged: running on WiFi (backup)"),
    (14, "ETH",  1, 1, -57, -60, "cable plugged in -> moves to Ethernet (main)"),
    (14, "ETH",  0, 1, None, None, "WiFi killed -> still on Ethernet, no interruption"),
    (12, "ETH",  1, 1, -58, -56, "WiFi back -> stays on Ethernet"),
    (16, "WiFi", 1, 0, -56, -58, "cable pulled -> failover to WiFi"),
    (12, "ETH",  1, 1, -57, -57, "cable back -> returns to Ethernet"),
]


def sensors(i):
    t = i / 15
    return {
        "temp": round(27.0 + 0.8 * math.sin(t) + random.uniform(-0.1, 0.1), 1),
        "hum": round(61.0 + 2.5 * math.sin(t / 2 + 1) + random.uniform(-0.3, 0.3), 1),
        "lux": round(320 + 90 * math.sin(t / 1.5) + random.uniform(-8, 8), 1),
    }


def real_node_publishing(c, seconds=5):
    """True if someone else is already publishing on TOPIC."""
    seen = []
    c.on_message = lambda cl, u, m: seen.append(m.payload)
    c.subscribe(TOPIC)
    time.sleep(seconds)
    c.unsubscribe(TOPIC)
    c.on_message = None
    return bool(seen)


def main():
    c = mqtt.Client(client_id="iotbhai-sim", callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    c.connect(HOST, PORT, 30)
    c.loop_start()
    if "--force" not in sys.argv:
        print(f"checking {TOPIC} for a real node (5 s)...")
        if real_node_publishing(c):
            print("A real node is already publishing on this topic. Stop it first,\n"
                  "or run with --force (the dashboard will see both mixed together).")
            c.loop_stop()
            c.disconnect()
            return
    count = 0
    boot = time.time() - 2 * 3600 - 13 * 60     # pretend the node booted 2h13m ago
    try:
        while True:
            for secs, link, wifi, eth, r0, r1, note in SCRIPT:
                print(f"--- {note}")
                steps = secs // 2
                for k in range(steps):
                    count += 1
                    rssi = None
                    if r0 is not None:
                        rssi = round(r0 + (r1 - r0) * k / max(1, steps - 1) + random.uniform(-1.5, 1.5))
                    p = {
                        "link": link, **sensors(count), "count": count,
                        "wifi": wifi, "eth": eth, "rssi": rssi,
                        "up": int(time.time() - boot), "ip": IP[link], "fw": FW,
                        "pref": PREF,
                    }
                    c.publish(TOPIC, json.dumps(p))
                    print(p)
                    time.sleep(2)
            if "--loop" not in sys.argv:
                break
    except KeyboardInterrupt:
        pass
    finally:
        c.loop_stop()
        c.disconnect()


if __name__ == "__main__":
    main()
