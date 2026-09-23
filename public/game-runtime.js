/* 工厂内置探索引擎。仅消费验证过的游戏数据，不执行模型返回的代码。 */
(() => {
    'use strict';
    const spec = window.GAME_SPEC;
    const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
    const message = document.getElementById('message'), status = document.getElementById('status');
    const overlay = document.getElementById('overlay'), heading = document.getElementById('heading');
    const description = document.getElementById('description'), actions = document.getElementById('actions');
    const keys = new Set(), images = {};
    let levelIndex = 0, level, player, collected, lives, paused = true, over = false, started = false;
    let time = 0, last = 0, invulnerable = 0, audioEnabled = true, music, dialogueOpen = false;
    const S = 48, W = 960, H = 576;
    canvas.width = W; canvas.height = H;
    document.getElementById('title').textContent = spec.title;
    document.getElementById('goal').textContent = spec.goal;
    const asset = name => window.GAME_ASSETS?.[name] || `assets/${name}`;
    ['player', 'item', 'npc'].forEach(name => { const img = new Image(); img.src = asset(`${name}.svg`); images[name] = img; });
    function play(name) {
        if (!audioEnabled) return;
        const sound = new Audio(asset(`${name}.wav`)); sound.volume = .25; sound.play().catch(() => {});
    }
    function startMusic() {
        if (!music) { music = new Audio(asset('music.wav')); music.loop = true; music.volume = .08; }
        if (audioEnabled) music.play().catch(() => {});
    }
    function say(title, body, buttons) {
        heading.textContent = title; description.textContent = body; actions.replaceChildren();
        buttons.forEach(([label, fn]) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; actions.append(b); });
        overlay.hidden = false; paused = true; keys.clear();
        actions.firstElementChild?.focus();
    }
    function resume() { paused = false; overlay.hidden = true; dialogueOpen = false; canvas.focus(); startMusic(); }
    function loadLevel(index) {
        levelIndex = index; level = spec.levels[index]; player = { ...level.spawn }; collected = new Set();
        invulnerable = 1; time = 0; dialogueOpen = false;
        message.textContent = `${level.intro} · 收集${spec.collectible.name}后前往出口。`;
    }
    function restart() { lives = spec.rules.lives; over = false; started = true; loadLevel(0); resume(); }
    function blocked(x, y) {
        if (x < .8 || x > 18.2 || y < .8 || y > 10.2) return true;
        return level.walls.some(p => Math.abs(p.x - x) < .74 && Math.abs(p.y - y) < .74);
    }
    function hazard(h) { return { x: h.x + (h.axis === 'x' ? Math.sin(time * 1.2) * h.range : 0), y: h.y + (h.axis === 'y' ? Math.sin(time * 1.2) * h.range : 0) }; }
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    function interact() {
        if (paused || !started || distance(player, level.npc) > 1.6) return;
        dialogueOpen = true;
        say(level.npc.name, level.npc.dialogue, [
            ...level.npc.choices.map(choice => [choice.label, () => say(level.npc.name, choice.response, [['继续探索', resume]])]), ['离开', resume]
        ]);
    }
    function update(dt) {
        if (paused || over) return;
        time += dt; invulnerable = Math.max(0, invulnerable - dt);
        let dx = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
        let dy = (keys.has('ArrowDown') || keys.has('s') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('w') ? 1 : 0);
        if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
        const step = dt * spec.rules.speed;
        if (!blocked(player.x + dx * step, player.y)) player.x += dx * step;
        if (!blocked(player.x, player.y + dy * step)) player.y += dy * step;
        level.items.forEach((p, i) => {
            if (!collected.has(i) && distance(player, p) < .65) { collected.add(i); play('collect'); }
        });
        if (!invulnerable && level.hazards.some(h => distance(player, hazard(h)) < .65)) {
            lives--; play('danger'); player = { ...level.spawn }; invulnerable = 2;
            if (lives <= 0) { over = true; say('再试一次', '躲开移动的红色危险物。已探索的路线会帮助你。', [['重新开始', restart]]); }
        }
        if (!over && collected.size === level.items.length && distance(player, level.exit) < .7) {
            play('win');
            if (levelIndex + 1 < spec.levels.length) {
                const next = levelIndex + 1;
                say('通路已打开', spec.levels[next].intro, [['进入下一关', () => { loadLevel(next); resume(); }]]);
            } else { over = true; say('旅程完成', spec.ending, [['再玩一次', restart]]); }
        }
        status.textContent = `${level.name} · ${levelIndex + 1}/${spec.levels.length} 关 · ${spec.collectible.name} ${collected.size}/${level.items.length} · 生命 ${lives}`;
        document.getElementById('interact').disabled = distance(player, level.npc) > 1.6 || paused;
    }
    function sprite(name, p, size, bob = 0) {
        const img = images[name]; const x = (p.x + .5) * S, y = (p.y + .5) * S;
        ctx.fillStyle = '#0005'; ctx.beginPath(); ctx.ellipse(x, y + size * .35, size * .38, size * .13, 0, 0, Math.PI * 2); ctx.fill();
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, x - size / 2, y - size / 2 + bob, size, size);
    }
    function draw() {
        ctx.fillStyle = level.background; ctx.fillRect(0, 0, W, H);
        for (let y = 1; y <= 10; y++) for (let x = 1; x <= 18; x++) {
            ctx.globalAlpha = (x + y) % 2 ? .55 : .7; ctx.fillStyle = spec.palette.floor; ctx.fillRect(x * S + 1, y * S + 1, S - 2, S - 2);
            ctx.globalAlpha = 1;
        }
        level.walls.forEach(p => { ctx.fillStyle = '#0005'; ctx.fillRect(p.x * S + 5, p.y * S + 10, S - 4, S - 4); ctx.fillStyle = spec.palette.wall; ctx.fillRect(p.x * S + 2, p.y * S - 4, S - 4, S - 4); ctx.fillStyle = '#ffffff18'; ctx.fillRect(p.x * S + 2, p.y * S - 4, S - 4, 8); });
        const exit = level.exit;
        ctx.fillStyle = collected.size === level.items.length ? spec.palette.accent : '#718096';
        ctx.fillRect(exit.x * S + 8, exit.y * S, S - 16, S);
        ctx.fillStyle = '#17242e'; ctx.fillRect(exit.x * S + 13, exit.y * S + 5, S - 26, S - 5);
        ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('出口', (exit.x + .5) * S, exit.y * S - 8);
        level.items.forEach((p, i) => { if (!collected.has(i)) sprite('item', p, 32, Math.sin(time * 3 + i) * 3); });
        sprite('npc', level.npc, 38, Math.sin(time * 2) * 1.5);
        ctx.fillStyle = '#fff'; ctx.fillText(level.npc.name, (level.npc.x + .5) * S, level.npc.y * S - 7);
        level.hazards.forEach(h => {
            const p = hazard(h), x = (p.x + .5) * S, y = (p.y + .5) * S;
            ctx.fillStyle = '#ed7973'; ctx.beginPath(); ctx.moveTo(x, y - 17); ctx.lineTo(x + 17, y + 14); ctx.lineTo(x - 17, y + 14); ctx.fill();
            ctx.fillStyle = '#371f25'; ctx.font = 'bold 17px sans-serif'; ctx.fillText('!', x, y + 8);
        });
        if (!invulnerable || Math.floor(time * 10) % 2 === 0) sprite('player', player, 42, keys.size ? Math.sin(time * 14) * 2 : 0);
    }
    function frame(timestamp) { const dt = Math.min(.035, (timestamp - (last || timestamp)) / 1000); last = timestamp; update(dt); draw(); requestAnimationFrame(frame); }
    function pause() { if (!started || over || dialogueOpen) return; if (paused) resume(); else { music?.pause(); say('已暂停', '准备好后继续。', [['继续游戏', resume], ['重新开始', restart]]); } }
    window.addEventListener('keydown', e => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', ' ', 'e', 'Escape'].includes(k)) {
            if (e.target.tagName === 'BUTTON' && [' ', 'Enter'].includes(k)) return;
            e.preventDefault(); if (k === 'e' && !e.repeat) interact(); else if (k === 'Escape' && !e.repeat) pause(); else if (!paused) keys.add(k);
        }
    });
    window.addEventListener('keyup', e => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    window.addEventListener('blur', () => { keys.clear(); if (started && !paused && !over) pause(); });
    document.querySelectorAll('[data-key]').forEach(b => {
        b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); keys.add(b.dataset.key); };
        b.onpointerup = b.onpointercancel = b.onlostpointercapture = () => keys.delete(b.dataset.key);
    });
    document.getElementById('pause').onclick = pause;
    document.getElementById('interact').onclick = interact;
    document.getElementById('sound').onclick = e => { audioEnabled = !audioEnabled; e.target.textContent = audioEnabled ? '声音：开' : '声音：关'; if (!audioEnabled) music?.pause(); else if (!paused) startMusic(); };
    lives = spec.rules.lives; loadLevel(0);
    say(spec.title, `${spec.tagline}\n${spec.goal}\n方向键 / WASD 移动，E 对话，Esc 暂停；手机使用下方按钮。`, [['开始游戏', restart]]);
    requestAnimationFrame(frame);
})();
