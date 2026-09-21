/**
 * The flock.
 *
 * This is the only ornament in Shepard, and it earns its place by being an
 * honest instrument: every element is driven by real state. The states are the
 * ones the system actually has, including `blind` — if the last audit could not
 * run, fog rolls in and the sheep stop being visible, because a system with
 * three-valued logic must not have a two-valued picture. Sheep that look safe
 * when Shepard cannot see them would be the most dangerous pixel in the product.
 */
const Scene = (() => {
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const GROUND = H - 12;

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  let state = 'idle';
  let t = 0;

  const SHEEP_COUNT = 7;
  const sheep = Array.from({ length: SHEEP_COUNT }, (_, i) => ({
    x: 40 + i * 24 + (i % 3) * 5,
    phase: i * 1.7,
    drift: (i % 2 ? 1 : -1) * (0.08 + (i % 3) * 0.03),
  }));

  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x | 0, y | 0, w, h); };

  function drawTree(x) {
    const fg = css('--fg'), dim = css('--dim');
    px(x + 5, GROUND - 12, 3, 12, dim);          // trunk
    px(x, GROUND - 17, 13, 5, fg);               // canopy, widest at the base
    px(x + 1, GROUND - 22, 11, 5, fg);
    px(x + 3, GROUND - 26, 7, 4, fg);
    px(x + 5, GROUND - 28, 3, 2, fg);
  }

  function drawSheep(s, opts) {
    const c = opts.faint ? css('--dim') : css('--fg');
    const bob = Math.sin(t / 22 + s.phase) > 0.6 ? 1 : 0;   // grazing dip
    const y = GROUND - 6 + bob;
    px(s.x, y, 7, 4, c);            // body
    px(s.x + 6, y - 2, 3, 3, c);    // head
    px(s.x + 1, y + 4, 1, 2, c);    // legs
    px(s.x + 5, y + 4, 1, 2, c);
  }

  function drawShepherd(x, opts) {
    const c = css('--fg');
    const resting = opts.resting;
    const y = resting ? GROUND - 7 : GROUND - 11;
    px(x + 1, y, 3, 3, c);                       // head
    px(x + 1, y + 3, 3, resting ? 4 : 5, c);     // body
    // the crook
    px(x + 5, GROUND - 12, 1, 12, c);
    px(x + 5, GROUND - 13, 3, 1, c);
    if (!resting) {                              // legs, alert stance
      px(x, y + 8, 1, 3, c);
      px(x + 4, y + 8, 1, 3, c);
    }
  }

  function drawWolf(x) {
    const c = css('--alert');
    px(x, GROUND - 5, 9, 4, c);       // body
    px(x + 8, GROUND - 7, 4, 3, c);   // head
    px(x + 11, GROUND - 8, 1, 1, c);  // ear
    px(x - 2, GROUND - 7, 3, 2, c);   // tail
    px(x + 1, GROUND - 1, 1, 2, c);
    px(x + 6, GROUND - 1, 1, 2, c);
  }

  function drawFog() {
    // Fog is drawn as dithered pixels rather than a translucent wash so it stays
    // inside the old-computer language instead of becoming a modern overlay.
    ctx.fillStyle = css('--bg');
    for (let y = 0; y < H; y += 2) {
      for (let x = (y / 2 + Math.floor(t / 30)) % 2; x < W; x += 2) {
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(x, y + 1, 1, 1);
      }
    }
    ctx.fillStyle = css('--dim');
    for (let i = 0; i < 5; i++) {
      const y = 14 + i * 11;
      const x = ((t / 3 + i * 40) % (W + 60)) - 30;
      ctx.fillRect(x, y, 26, 1);
      ctx.fillRect(x + 8, y + 2, 20, 1);
    }
  }

  function frame() {
    t++;
    ctx.clearRect(0, 0, W, H);
    px(0, GROUND + 6, W, 1, css('--dim'));   // horizon
    drawTree(20);

    const gathering = state === 'onboarding';
    const threatened = state === 'critical';
    const blind = state === 'blind';

    sheep.forEach((s, i) => {
      if (gathering) {
        // Drawn towards the shepherd: Shepard is taking inventory of the flock.
        s.x += (60 + i * 10 - s.x) * 0.004;
      } else if (threatened) {
        // Huddled, but still countable. A flock that merges into one blob stops
        // telling the user how much is at stake.
        s.x += (40 + i * 11 - s.x) * 0.012;
      } else {
        s.x += s.drift * (state === 'healthy' ? 0.35 : 1);
        if (s.x < 34 || s.x > W - 30) s.drift *= -1;
      }
      drawSheep(s, { faint: blind });
    });

    if (state !== 'idle') {
      const resting = state === 'healthy';
      const x = gathering ? 70 + Math.sin(t / 60) * 14 : threatened ? W - 90 : 26;
      drawShepherd(x, { resting });
    }

    if (threatened) {
      const approach = W - 20 - (Math.sin(t / 90) + 1) * 18;
      drawWolf(approach);
    }

    if (blind) drawFog();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return { set(next) { state = next; } };
})();
