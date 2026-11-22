"""
Real two-Firefox end-to-end test of the extension.

Starts the local relay, serves test/video.html, installs a *test build* of the
extension in two independent headless Firefox profiles, and verifies that
play / pause / seek / drift correction / <video> re-attach sync between them.

The test build differs from production only in background.js default settings
(auto-connect, fixed server URL, room and user name) so the popup UI does not
have to be automated. All sync logic and the content script are unchanged.

Run from the repo root:  py -3 test/firefox_e2e.py
"""
import functools
import http.server
import shutil
import subprocess
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[1]
RELAY_DIR = ROOT / "relay" / "node"
ROOM = "firefox-e2e"
PORT = 8080
RELAY_PORT = 8787
XPI_DIR = ROOT / "test" / "_xpi"


def build_test_xpi(user: str) -> Path:
    XPI_DIR.mkdir(exist_ok=True)
    path = XPI_DIR / f"syncplay-{user}.xpi"
    files = {
        "manifest.json": (ROOT / "manifest.json").read_text(encoding="utf-8"),
        "src/shared/protocol.js": (ROOT / "src/shared/protocol.js").read_text(encoding="utf-8"),
        "src/content/content.js": (ROOT / "src/content/content.js").read_text(encoding="utf-8"),
        "src/background/background.js": (ROOT / "src/background/background.js").read_text(encoding="utf-8"),
        "src/popup/popup.html": (ROOT / "src/popup/popup.html").read_text(encoding="utf-8"),
        "src/popup/popup.js": (ROOT / "src/popup/popup.js").read_text(encoding="utf-8"),
        "src/popup/popup.css": (ROOT / "src/popup/popup.css").read_text(encoding="utf-8"),
    }
    bg = files["src/background/background.js"]
    original = (
        'serverUrl: "ws://localhost:8787/ws",\n'
        '    room: "lobby",\n'
        '    user: "Guest-" + Math.random().toString(36).slice(2, 6).toUpperCase(),\n'
        '    wantConnected: false,'
    )
    patched = (
        f'serverUrl: "ws://127.0.0.1:{RELAY_PORT}/ws",\n'
        f'    room: "{ROOM}",\n'
        f'    user: "{user}",\n'
        '    wantConnected: true,'
    )
    assert original in bg, "Could not patch background defaults (source changed)"
    files["src/background/background.js"] = bg.replace(original, patched, 1)

    # Test-only "breadcrumbs": piggyback on CLOCK so Selenium can see background state.
    bg = files["src/background/background.js"]
    bg = bg.replace(
        '    notifyPopup();\n  }\n\n  function applyRemoteEvent(msg)',
        '    broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "SENT:" + action + ":" + p });\n'
        '    notifyPopup();\n  }\n\n  function applyRemoteEvent(msg)', 1)
    bg = bg.replace(
        '  function applyRemoteEvent(msg) {\n',
        '  function applyRemoteEvent(msg) {\n'
        '    broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "GOT:" + msg.action + ":" + msg.position });\n', 1)
    bg = bg.replace(
        '      case "welcome":\n        connected = true;',
        '      case "welcome":\n        broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "WELCOME" });\n'
        '        connected = true;', 1)
    bg = bg.replace(
        '    ws.onopen = () => {',
        '    ws.onopen = () => {\n      broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "OPEN" });', 1)
    bg = bg.replace(
        '    ws.onerror = () => {',
        '    ws.onerror = () => {\n      broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "ERROR" });', 1)
    bg = bg.replace(
        '    ws.onclose = () => {\n      connected = false;',
        '    ws.onclose = (ev) => {\n      broadcastTabs({ type: BG_TO_CONTENT, action: CLOCK, offset, rtt, debug: "CLOSED:" + (ev && ev.code) + ":" + (ev && ev.reason) });\n'
        '      connected = false;', 1)
    files["src/background/background.js"] = bg

    # Test-only DOM markers so Selenium can observe the isolated content script.
    content = files["src/content/content.js"]
    content = content.replace(
        '    sendBg(LOCAL_EVENT, {',
        '    document.documentElement.dataset.spLocal = type + ":" + video.currentTime + ":" + event.type;\n'
        '    sendBg(LOCAL_EVENT, {', 1)
    content = content.replace(
        '  function applyRemote(message) {\n    if (!video) return;',
        '  function applyRemote(message) {\n    document.documentElement.dataset.spApply = message.action + ":" + message.position + ":" + message.paused;\n'
        '    if (!video) return;', 1)
    content = content.replace(
        '      case CLOCK:\n        clockOffset = Number(message.offset) || 0;',
        '      case CLOCK:\n        document.documentElement.dataset.spClock = String(message.offset);\n'
        '        if (message.debug) document.documentElement.dataset.spTrace = ((document.documentElement.dataset.spTrace || "") + message.debug + " ").slice(-300);\n'
        '        clockOffset = Number(message.offset) || 0;', 1)
    content = content.replace(
        '    sendBg(REGISTER, { hasVideo: true });',
        '    document.documentElement.dataset.spReady = "1";\n'
        '    sendBg(REGISTER, { hasVideo: true });', 1)
    files["src/content/content.js"] = content

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, text in files.items():
            z.writestr(rel, text)
        for icon in ["icons/icon-48.png", "icons/icon-96.png"]:
            z.write(ROOT / icon, icon)
    return path


def wait_for_http(url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return True
        except Exception:
            time.sleep(0.2)
    return False


def check(label, condition):
    status = "ok" if condition else "FAIL"
    print(f"{status} - {label}", flush=True)
    if not condition:
        raise AssertionError(label)


def video_state(driver):
    return driver.execute_script(
        "const v=document.querySelector('video');"
        "return v ? {paused:v.paused, time:v.currentTime, ready:v.readyState, count:document.querySelectorAll('video').length} : null;"
    )


def set_video(driver, time_sec, play):
    return driver.execute_async_script(
        "const t=arguments[0], shouldPlay=arguments[1], done=arguments[2];"
        "const v=document.querySelector('video');"
        "v.muted=true;"
        "v.currentTime=t;"
        "if(!shouldPlay){v.pause();done(true);return;}"
        "v.play().then(()=>done(true),e=>done(String(e)));",
        time_sec,
        play,
    )


def wait_video(driver, predicate, label, timeout=15):
    try:
        WebDriverWait(driver, timeout, poll_frequency=0.2).until(
            lambda d: predicate(video_state(d))
        )
        check(label, True)
        return video_state(driver)
    except Exception as exc:
        check(label, False)


def launch_driver(xpi):
    options = Options()
    options.add_argument("-headless")
    driver = webdriver.Firefox(options=options)
    driver.set_page_load_timeout(30)
    driver.install_addon(str(xpi), temporary=True)
    driver.get(f"http://127.0.0.1:{PORT}/test/video.html")
    wait_video(driver, lambda s: s and s["ready"] >= 2, "video ready in " + driver.current_url.split("/")[-1], 20)
    driver.execute_script("const v=document.querySelector('video'); v.muted=true; v.loop=true")
    return driver


relay = None
httpd = None
drivers = []
try:
    relay_log = ROOT / "test" / "_relay.log"
    relay_log.write_text("", encoding="utf-8")
    relay = subprocess.Popen(
        ["node", "server.js"], cwd=str(RELAY_DIR),
        stdout=open(relay_log, "w", encoding="utf-8"), stderr=subprocess.STDOUT,
    )
    check("local relay starts", wait_for_http(f"http://127.0.0.1:{RELAY_PORT}/health"))

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(ROOT)
    )
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    check("test page is served", wait_for_http(f"http://127.0.0.1:{PORT}/test/video.html"))

    drivers.append(launch_driver(build_test_xpi("Alice")))
    drivers.append(launch_driver(build_test_xpi("Bob")))
    a, b = drivers
    time.sleep(2)  # allow both event pages to join the room
    print("Firefox versions:", a.capabilities.get("browserVersion"), b.capabilities.get("browserVersion"), flush=True)
    result = set_video(a, 1.0, True)
    check("Firefox allows muted programmatic play", result is True)
    wait_video(b, lambda s: s and not s["paused"] and s["time"] >= 0.5, "remote play reaches second Firefox")

    set_video(a, 1.0, False)
    wait_video(b, lambda s: s and s["paused"] and abs(s["time"] - 1.0) < 0.8, "remote pause reaches second Firefox")

    set_video(a, 3.0, False)
    wait_video(b, lambda s: s and abs(s["time"] - 3.0) < 0.5, "remote seek reaches second Firefox")

    # Force >1 s drift in Bob; the next heartbeat should hard-seek him back.
    set_video(b, 1.5, False)
    drift_fixed = False
    deadline = time.time() + 8
    while time.time() < deadline:
        state = video_state(b)
        if state and abs(state["time"] - 3.0) < 0.8:
            drift_fixed = True
            break
        time.sleep(0.2)
    check("heartbeat hard-seeks >1 s drift", drift_fixed)

    # Re-create the <video> element in Bob's page (MutationObserver re-attach).
    b.find_element(By.ID, "replace").click()
    wait_video(b, lambda s: s and s["count"] == 1 and s["ready"] >= 2, "video element replaced successfully")
    set_video(a, 2.0, False)
    wait_video(b, lambda s: s and abs(s["time"] - 2.0) < 0.5, "sync survives <video> replacement", 15)

    # Unmuted remote play should be blocked by autoplay policy and show the prompt.
    set_video(b, 0, False)
    b.execute_script("document.querySelector('video').muted=false")
    set_video(a, 1.0, True)
    try:
        WebDriverWait(b, 6).until(
            lambda d: d.execute_script("return !!document.getElementById('syncplay-autoplay-prompt')")
        )
        check("autoplay-blocked 'click to sync' prompt appears", True)
    except Exception:
        # Some Firefox configs allow unmuted programmatic play; then no prompt is expected.
        state_b = video_state(b)
        if state_b and not state_b["paused"]:
            print("skip - autoplay allowed unmuted play in this Firefox config; no prompt expected", flush=True)
        else:
            check("autoplay-blocked 'click to sync' prompt appears", False)

    print("ALL FIREFOX E2E TESTS PASSED", flush=True)
except Exception as exc:
    print("FIREFOX E2E FAILED:", type(exc).__name__, str(exc)[:1200], flush=True)
    raise
finally:
    for driver in drivers:
        try:
            driver.quit()
        except Exception:
            pass
    if httpd:
        httpd.shutdown()
        httpd.server_close()
    if relay:
        relay.terminate()
        try:
            relay.wait(timeout=5)
        except Exception:
            relay.kill()
    shutil.rmtree(XPI_DIR, ignore_errors=True)
    (ROOT / "test" / "_relay.log").unlink(missing_ok=True)
