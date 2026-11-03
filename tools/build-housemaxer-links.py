#!/usr/bin/env python3
"""Build links/housemaxer/index.html from HouseMaxer's parts/parts.json.

The parts list lives in the HouseMaxer repo; this page shows the same parts
with the same Amazon links. Rerun it after the parts list changes:

    python3 tools/build-housemaxer-links.py PATH/TO/HouseMaxer/parts/parts.json
    python3 tools/build-housemaxer-links.py parts.json --tag other-tracking-20

--tag swaps the Amazon Associates tracking ID, so this page's sales can be
counted apart from the repo's.
"""
import argparse
import html
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "links" / "housemaxer" / "index.html"
REPO = "https://github.com/MaxeThis/HouseMaxer"

# Parts in the apartment, checked against Home Assistant's device list.
# "older" means I own an earlier model of the listed one.
MINE = {
    "pi5_8gb": "mine", "asus_xt8": "mine", "august_lock": "mine",
    "hue_bridge": "mine", "switchbot_hub2": "mine", "fluval_flex": "mine",
    "roborock_qrevo_plus": "mine", "oralb_io": "mine", "q990d": "mine",
    "hue_a19_color": "older", "hue_a21": "older", "hue_ambiance": "older",
    "lg_oled": "older",
    "esp32": "mine", "usbc_cable": "mine", "usb_wall": "spare",
}
TAGS = {"mine": "Max uses this", "older": "Max uses an older model", "spare": "Max uses spare power banks"}
# A second tag after the first. The ESP32 boards are "the bug" from the video.
EXTRA = {"esp32": ("bug", "🐛 The bug")}

# This page never suggests buying used: skip those listings and reword.
SKIP = {"roborock_qrevo_plus_renewed"}
WHY = {
    "asus_xt8": "I use the ZenWiFi AX (XT8). Any current ZenWiFi works the same with Home Assistant.",
    "august_lock": "Fits over your deadbolt; your key still works. Comes with DoorSense.",
    "hue_bridge": "Links the bulbs to Home Assistant; works without the internet.",
    "roborock_qrevo_plus": "Vacuums, mops, empties itself, washes its pads.",
}
NO_USED = re.compile(r"\bused\b|ebay|refurb|renewed", re.I)

# The Pi parts read better as three ways to get Home Assistant running.
GROUPS = {
    "The brain": {
        "intro": "Pick one of three ways to run Home Assistant. [Guide 1](docs/01-raspberry-pi-and-home-assistant.md) explains the difference.",
        "options": [
            ("Option 1 · Easiest", "Home Assistant comes installed.", ["ha_green"]),
            ("Option 2 · One box", "Every Pi part in one kit.", ["pi5_kit"]),
            ("Option 3 · Part by part", "Pick the cooler or the case, not both.",
             ["pi5_8gb", "pi5_psu", "pi5_cooler", "pi5_case", "microsd"]),
        ],
        "after": ("For any option", ["zigbee_alt"]),
    },
}

# parts.json says "we"; this page is Max's own, so it says "I".
FIRST_PERSON = {"we": "I", "We": "I", "our": "my", "Our": "My", "ours": "mine", "Ours": "Mine", "us": "me"}
PLURAL = re.compile(r"\b(" + "|".join(FIRST_PERSON) + r")\b")


def singular(data):
    """Rewrite every text field in parts.json from "we" to "I"."""
    def fix(text):
        return PLURAL.sub(lambda m: FIRST_PERSON[m.group(1)], text)
    for s in data["sections"]:
        s["title"] = fix(s["title"])
        if s.get("intro"):
            s["intro"] = fix(s["intro"])
        for i in s["items"]:
            i["name"], i["why"] = fix(i["name"]), fix(i["why"])
    return data


def amazon(item, tag):
    if not item.get("asin"):
        return f"https://www.amazon.com/s?k={item['search'].replace(' ', '+')}&tag={tag}"
    return f"https://www.amazon.com/{item['key']}/dp/{item['asin']}?tag={tag}"


def inline(md):
    """Markdown links and bold to HTML; repo-relative links point at GitHub."""
    out = html.escape(md, quote=False)
    def link(m):
        href = m.group(2)
        if not href.startswith("http"):
            href = f"{REPO}/blob/main/{href}"
        return f'<a href="{html.escape(href)}" target="_blank" rel="noopener">{m.group(1)}</a>'
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, out)
    return re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)


def card(item, tag):
    why = WHY.get(item["key"], item["why"])
    if NO_USED.search(item["name"] + " " + why):
        raise SystemExit(f"{item['key']}: mentions buying used; add a WHY or SKIP entry")
    mine = MINE.get(item["key"])
    badge = f'<span class="tag {mine}">{TAGS[mine]}</span>' if mine else ""
    if item["key"] in EXTRA:
        kind, label = EXTRA[item["key"]]
        badge += f'<span class="tag {kind}">{html.escape(label)}</span>'
    return f"""      <a class="link" href="{html.escape(amazon(item, tag))}" target="_blank" rel="sponsored noopener">
        <span class="text"><span class="title">{html.escape(item['name'])}{badge}</span><span class="sub">{inline(why)}</span></span>
        <span class="go" aria-hidden="true">↗</span>
      </a>"""


def cards(items, tag):
    return "\n".join(card(i, tag) for i in items if i["key"] not in SKIP)


def grouped(s, g, tag):
    by_key = {i["key"]: i for i in s["items"]}
    placed = {k for _, _, keys in g["options"] for k in keys} | set(g["after"][1])
    if placed != set(by_key):
        raise SystemExit(f"{s['title']}: GROUPS does not match parts.json ({sorted(placed ^ set(by_key))})")
    out = [f'    <p class="intro">{inline(g["intro"])}</p>']
    for label, sub, keys in g["options"]:
        out.append(f"""    <div class="group">
      <div class="group-head"><span class="title">{html.escape(label)}</span><span class="sub">{html.escape(sub)}</span></div>
      <div class="links">
{cards([by_key[k] for k in keys], tag)}
      </div>
    </div>""")
    label, keys = g["after"]
    out.append(f'    <h3>{html.escape(label)}</h3>\n    <div class="links">\n{cards([by_key[k] for k in keys], tag)}\n    </div>')
    return "\n".join(out)


def page(data, tag):
    sections = []
    for s in data["sections"]:
        head = f'    <h2>{html.escape(s["title"])}</h2>'
        if s["title"] in GROUPS:
            sections.append(f"{head}\n{grouped(s, GROUPS[s['title']], tag)}")
            continue
        intro = f'\n    <p class="intro">{inline(s["intro"])}</p>' if s.get("intro") else ""
        sections.append(f'{head}{intro}\n    <div class="links">\n{cards(s["items"], tag)}\n    </div>')
    body = "\n\n".join(sections)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HouseMaxer · Links</title>
  <meta name="description" content="A smart apartment on a Raspberry Pi: the parts I bought, the guides and the code." />
  <link rel="stylesheet" href="/links/links.css?v=20261103c" />
</head>
<body>
  <!-- Built by tools/build-housemaxer-links.py from HouseMaxer parts/parts.json. Edit that, not this. -->
  <div class="blobs" aria-hidden="true"><span></span><span></span><span></span></div>
  <main>
    <a class="back" href="/links/">‹ All links</a>
    <header class="profile">
      <div class="avatar" aria-hidden="true">🏠</div>
      <h1>HouseMaxer</h1>
      <p class="lede">The door unlocks as you walk up, the lights fade when you brush your teeth, and it all runs on one Raspberry Pi.</p>
    </header>

    <div class="links">
      <a class="link folder" href="{REPO}" target="_blank" rel="noopener">
        <span class="icon" aria-hidden="true">💻</span>
        <span class="text"><span class="title">The code and guides</span><span class="sub">Build the same thing at home. Free on GitHub</span></span>
        <span class="go" aria-hidden="true">↗</span>
      </a>
    </div>

    <h2>The parts list</h2>
    <p class="note">As an Amazon Associate I earn from qualifying purchases. These are affiliate links: they cost you nothing extra and help fund the project. Prices change daily, so check the listing.</p>

{body}

    <footer>
      <p>Parts list checked {html.escape(data.get("checked", ""))}.</p>
      <a href="/links/">‹ All links</a>
    </footer>
  </main>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("parts", type=pathlib.Path, help="HouseMaxer parts/parts.json")
    ap.add_argument("--tag", help="Amazon tracking ID (default: the one in parts.json)")
    args = ap.parse_args()
    data = singular(json.loads(args.parts.read_text()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(page(data, args.tag or data["tag"]))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
