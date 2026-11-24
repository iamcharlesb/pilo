"""Export the reference scene's vector characters for Pilo's shared avatar renderer.
Run: python3 examples/pilo-animation/build-characters.py
"""
from pathlib import Path
import re
import json
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
scene = root / 'examples/pilo-animation/index.html'
svg = ET.fromstring(re.search(r'<svg\b[\s\S]*?</svg>', scene.read_text()).group())
defs = svg.find('defs')
for node in list(defs):
    if node.tag == 'filter':
        defs.remove(node)
views = {
    'pilo': '300 70 455 580', 'frog': '125 350 240 270',
    'heart': '745 375 245 250', 'yellow': '650 450 225 190',
    'blob': '150 450 235 190', 'bot': '735 190 170 205',
    'star': '-90 -95 180 195', 'cloud': '-105 -90 210 170',
    'cat': '-90 -90 180 190', 'nova': '-85 -95 170 180',
    'sage': '-85 -85 170 170', 'byte': '-110 -80 220 175',
    'marketing': '-90 -85 210 180', 'blogger': '-85 -85 180 180',
    'designer': '-90 -90 180 185'
}
art = {}
for node in svg.iter('g'):
    if 'character' not in node.get('class', '').split():
        continue
    name = node.get('data-name')
    motion = node.find("g")
    for child in motion.iter():
        child.attrib.pop('filter', None)
    markup = ET.tostring(motion, encoding='unicode')
    art[name] = {'viewBox': views[name], 'body': markup}
output = root / 'node/browser_agent/static/botCharacterArtwork.js'
output.write_text('''// Generated from examples/pilo-animation/index.html by build-characters.py.
(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiloCharacterArtwork = factory();
})(typeof window !== "undefined" ? window : globalThis, function() {
  return ''' + json.dumps({'defs': ET.tostring(defs, encoding='unicode'), 'characters': art}, indent=2) + ';\n});\n')
print(f'Exported {len(art)} vector characters.')
