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
    used = '<span class="tag">Buy used</span>' if item.get("used") else ""
    return f"""      <a class="link" href="{html.escape(amazon(item, tag))}" target="_blank" rel="sponsored noopener">
        <span class="text"><span class="title">{html.escape(item['name'])}{used}</span><span class="sub">{inline(item['why'])}</span></span>
        <span class="go" aria-hidden="true">↗</span>
      </a>"""


def page(data, tag):
    sections = []
    for s in data["sections"]:
        intro = f'\n    <p class="intro">{inline(s["intro"])}</p>' if s.get("intro") else ""
        cards = "\n".join(card(i, tag) for i in s["items"])
        sections.append(f'    <h2>{html.escape(s["title"])}</h2>{intro}\n    <div class="links">\n{cards}\n    </div>')
    body = "\n\n".join(sections)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HouseMaxer · Links</title>
  <meta name="description" content="A smart apartment on a Raspberry Pi: the parts we bought, the guides and the code." />
  <link rel="stylesheet" href="/links/links.css?v=20261103" />
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

    <h2>The parts we used</h2>
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
    data = json.loads(args.parts.read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(page(data, args.tag or data["tag"]))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
