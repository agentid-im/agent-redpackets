# Demo video

`script.md` is the storyboard and narration. The video is built from it in three steps; the tools
are not project dependencies (`npm i --no-save puppeteer-core ffmpeg-static`).

1. `node video/render.mjs`: the drawn scenes in `scenes.html`, rendered frame by frame.
2. `node video/record.mjs`: the two website scenes, recorded against a local chain (see the comment
   at the top of the script for the local chain and dev server it needs).
3. `node video/compose.mjs`: joins the scenes, adds English + Chinese subtitles, and lays the
   narration over each scene when `video/voice/vo-1.m4a` … `vo-8.m4a` exist.

Output: `video/out/agent-id-red-packets.mp4` (1920x1080, 30 fps).

The wallet confirmation in scene 5 is an illustration of the Agentic Wallet preview step and is
labelled as such; everything on the website scenes is the real site running on a local chain.
