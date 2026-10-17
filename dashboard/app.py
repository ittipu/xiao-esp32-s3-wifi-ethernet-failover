"""IoT Bhai — WiFi/Ethernet failover dashboard backend.

Flask + Flask-SocketIO serve the dashboard and push live updates to the browser.
A paho-mqtt client (its own thread) subscribes to the broker over plain MQTT,
logs every reading and every link switch to SQLite, and emits them over Socket.IO
so the page updates with no refresh.

    ESP32 -> mqtt.iotbhai.io:1883 -> this backend -> SQLite + Socket.IO -> browser

Run:  python app.py   (then open http://localhost:5000)
Config is via environment variables (see the defaults below).
"""

import json
import os
import sys
import threading
import time

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit

import paho.mqtt.client as mqtt

import db

# ------------------------------- config ------------------------------------
MQTT_HOST = os.getenv("MQTT_HOST", "mqtt.iotbhai.io")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")
TOPIC_NODE = os.getenv("TOPIC_NODE", "iotbhai/node")
TOPIC_SPEED = os.getenv("TOPIC_SPEED", "iotbhai/speed")
HTTP_PORT = int(os.getenv("HTTP_PORT", "5000"))
HISTORY_MIN = 60   # minutes of readings sent to a browser when it connects

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "iotbhai-failover")
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

# ---------------------------- shared state ---------------------------------
state_lock = threading.Lock()
state = {"link": "none", "up": None, "broker_connected": False}


def now():
    return time.time()


def num(v):
    """A payload number, or None for null / missing / not a number."""
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------- MQTT --------------------------------------
def on_connect(client, userdata, flags, reason_code, properties=None):
    ok = getattr(reason_code, "value", reason_code) == 0
    with state_lock:
        state["broker_connected"] = ok
    if ok:
        client.subscribe([(TOPIC_NODE, 0), (TOPIC_SPEED, 0)])
        print(f"[mqtt] connected; subscribed to {TOPIC_NODE} and {TOPIC_SPEED}")
    else:
        print(f"[mqtt] connect failed: {reason_code}")
    socketio.emit("broker", {"connected": ok})


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    with state_lock:
        state["broker_connected"] = False
    print("[mqtt] disconnected from broker")
    socketio.emit("broker", {"connected": False})


def emit_event(ts, kind, from_link, to_link):
    db.insert_event(ts, kind, from_link, to_link)
    socketio.emit("event", {"ts": ts, "type": kind, "from": from_link, "to": to_link})
    print(f"[event] {kind}: {from_link} -> {to_link}")


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8", "ignore"))
    except (ValueError, UnicodeError):
        return
    if not isinstance(payload, dict):
        return
    t = now()

    if msg.topic == TOPIC_SPEED:
        db.insert_speed(t, payload)
        socketio.emit("speed", {"ts": t, **payload})
        return

    # --- node reading ---
    up = num(payload.get("up"))
    r = {
        "ts": t,
        "link": str(payload.get("link", "none")),
        "temp": num(payload.get("temp")),
        "hum": num(payload.get("hum")),
        "lux": num(payload.get("lux")),
        "count": int(payload.get("count", 0)),
        "wifi": int(payload.get("wifi", 0)),
        "eth": int(payload.get("eth", 0)),
        "rssi": num(payload.get("rssi")),
        "up": int(up) if up is not None else None,
        "ip": payload.get("ip"),
        "fw": payload.get("fw"),
        "pref": payload.get("pref") or "WiFi",   # the node's main link (older firmware: WiFi)
    }

    events = []
    with state_lock:
        prev_link, prev_up = state["link"], state["up"]
        # uptime went backwards = the node rebooted
        if r["up"] is not None and prev_up is not None and r["up"] + 5 < prev_up:
            events.append(("restart", prev_link, r["link"]))
        if r["link"] != prev_link:
            if prev_link == "none":
                events.append(("online", "none", r["link"]))
            else:
                # onto the node's preferred (main) link = failback; away from it = failover
                kind = "failback" if r["link"] == r["pref"] else "failover"
                events.append((kind, prev_link, r["link"]))
        state["link"], state["up"] = r["link"], r["up"]

    db.insert_reading(r)
    socketio.emit("reading", r)
    for kind, a, b in events:
        emit_event(t, kind, a, b)


def start_mqtt():
    client = mqtt.Client(
        client_id="iotbhai-dashboard",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
            client.loop_forever()
        except Exception as e:  # noqa: BLE001 - keep the bridge alive
            print(f"[mqtt] connection error: {e}; retrying in 5 s")
            time.sleep(5)


# ------------------------------- HTTP --------------------------------------
@app.route("/")
def index():
    return render_template("index.html", broker=f"{MQTT_HOST}:{MQTT_PORT}", topic=TOPIC_NODE)


@app.route("/api/history")
def api_history():
    minutes = min(max(request.args.get("minutes", 60, type=int), 1), 1440)
    return jsonify(db.readings_since(now() - minutes * 60))


@app.route("/api/events")
def api_events():
    return jsonify(db.recent_events(100))


@app.route("/api/stats")
def api_stats():
    return jsonify(db.stats())


# ---------------------------- Socket.IO ------------------------------------
@socketio.on("connect")
def on_client_connect():
    with state_lock:
        broker = state["broker_connected"]
    emit(
        "snapshot",
        {
            "broker_connected": broker,
            "readings": db.readings_since(now() - HISTORY_MIN * 60),
            "events": db.recent_events(50),
            "stats": db.stats(),
            "server_ts": now(),
        },
    )


# ------------------------------- main --------------------------------------
if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)   # logs show up immediately
    db.init()
    last = db.last_reading()                      # carry state across a restart
    if last:
        state["link"], state["up"] = last["link"], last["up"]
    threading.Thread(target=start_mqtt, daemon=True).start()
    print(f"[http] dashboard on http://localhost:{HTTP_PORT}")
    socketio.run(app, host="0.0.0.0", port=HTTP_PORT, allow_unsafe_werkzeug=True)
