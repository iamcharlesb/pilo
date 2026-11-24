# Animated Pilo crew

Open `index.html` directly in a browser. The scene contains 15 independently animated characters and Original, Thinking, Writing, Sad, and Happy modes. It works offline and respects reduced-motion preferences.

Pilo uses the same vector artwork in its sidebar, chat, bot picker, and catalog. Coding uses Byte (terminal), marketing uses Moxie (megaphone), blogging uses Quill (notebook), and design uses Hue (palette). All 15 characters are selectable in the bot avatar picker. Owner-picked classic silhouettes and portrait uploads retain their existing appearance.

After changing the scene artwork, regenerate Pilo's shared asset:

```sh
python3 examples/pilo-animation/build-characters.py
```

The runtime renderer and state animations live in `node/browser_agent/static/botCharacters.js` and `botCharacters.css`. Changes to those files do not require regenerating the artwork. Run the browser-runtime checks with `npm --prefix node/browser_agent test`.
